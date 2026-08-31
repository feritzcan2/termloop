import { DurableObject } from "cloudflare:workers";

const RELAY_PROTOCOL_VERSION = 1;
const MAX_ROOM_SOCKETS = 4;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const ROOM_PATH = /^\/v1\/relay\/([a-f0-9]{32})$/;

type RelaySide = "mac" | "mobile";

interface RelayAttachment {
  readonly authenticated: boolean;
  readonly side?: RelaySide;
  readonly tokenHash?: readonly number[];
  readonly connectedAtEpochMs: number;
  readonly roomId: string;
  readonly forwardedMessages: number;
  readonly forwardedBytes: number;
}

interface RelayAuthentication {
  readonly type: "relay.authenticate";
  readonly relayProtocolVersion: 1;
  readonly side: RelaySide;
  readonly roomId: string;
  readonly token: string;
}

export class RelayRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
    }
    const current = this.ctx.getWebSockets();
    if (current.length >= MAX_ROOM_SOCKETS) {
      return Response.json({ error: "Relay room is busy" }, { status: 429 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const roomId = ROOM_PATH.exec(new URL(request.url).pathname)?.[1];
    if (roomId === undefined) return new Response("Not Found", { status: 404 });
    server.serializeAttachment({
      authenticated: false,
      connectedAtEpochMs: Date.now(),
      roomId,
      forwardedMessages: 0,
      forwardedBytes: 0,
    } satisfies RelayAttachment);
    this.ctx.acceptWebSocket(server);
    log("socket_accepted", { activeSockets: current.length + 1 });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = relayAttachment(socket);
    if (!attachment.authenticated) {
      if (typeof message !== "string") return socket.close(1008, "authentication required");
      if (message.length > 512) return socket.close(1009, "authentication message is too large");
      const authentication = parseAuthentication(message);
      if (authentication === undefined || authentication.roomId !== attachment.roomId) {
        return socket.close(1008, "invalid authentication");
      }
      const tokenHash = new Uint8Array(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(authentication.token),
      ));
      const authenticated = this.authenticatedSockets();
      const establishedHash = authenticated[0]?.attachment.tokenHash;
      if (establishedHash !== undefined
        && !constantTimeEqual(tokenHash, new Uint8Array(establishedHash))) {
        log("authentication_refused", { side: authentication.side });
        return socket.close(1008, "invalid authentication");
      }
      for (const peer of authenticated) {
        if (peer.attachment.side === authentication.side) peer.socket.close(1012, "connection replaced");
      }
      socket.serializeAttachment({
        ...attachment,
        authenticated: true,
        side: authentication.side,
        tokenHash: [...tokenHash],
      } satisfies RelayAttachment);
      log("authenticated", { side: authentication.side });
      this.publishReady();
      return;
    }

    if (typeof message === "string") return socket.close(1003, "relay payload must be binary");
    if (message.byteLength > MAX_MESSAGE_BYTES) return socket.close(1009, "relay payload is too large");
    const peer = this.authenticatedSockets().find(({ attachment: candidate }) => (
      candidate.side !== attachment.side
    ));
    if (peer === undefined) return socket.close(1013, "relay peer unavailable");
    peer.socket.send(message);
    socket.serializeAttachment({
      ...attachment,
      forwardedMessages: attachment.forwardedMessages + 1,
      forwardedBytes: attachment.forwardedBytes + message.byteLength,
    } satisfies RelayAttachment);
  }

  webSocketClose(socket: WebSocket, code: number): void {
    const attachment = relayAttachment(socket);
    log("socket_closed", {
      side: attachment.side,
      closeCode: code,
      lifetimeMs: Date.now() - attachment.connectedAtEpochMs,
      forwardedMessages: attachment.forwardedMessages,
      forwardedBytes: attachment.forwardedBytes,
    });
    if (!attachment.authenticated) return;
    for (const peer of this.authenticatedSockets()) {
      if (peer.socket === socket || peer.attachment.side === attachment.side) continue;
      peer.socket.send(JSON.stringify({ type: "relay.waiting", relayProtocolVersion: RELAY_PROTOCOL_VERSION }));
      peer.socket.close(1012, "relay peer disconnected");
    }
  }

  webSocketError(socket: WebSocket): void {
    const attachment = relayAttachment(socket);
    log("socket_error", { side: attachment.side });
    socket.close(1011, "relay socket error");
  }

  private authenticatedSockets(): Array<{ socket: WebSocket; attachment: RelayAttachment }> {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = relayAttachment(socket);
      return attachment.authenticated ? [{ socket, attachment }] : [];
    });
  }

  private publishReady(): void {
    const authenticated = this.authenticatedSockets();
    if (!authenticated.some(({ attachment }) => attachment.side === "mac")
      || !authenticated.some(({ attachment }) => attachment.side === "mobile")) return;
    const ready = JSON.stringify({ type: "relay.ready", relayProtocolVersion: RELAY_PROTOCOL_VERSION });
    for (const { socket } of authenticated) socket.send(ready);
    log("room_ready", { activeSockets: authenticated.length });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ready: true }, { headers: { "cache-control": "no-store" } });
    }
    const match = ROOM_PATH.exec(url.pathname);
    if (request.method !== "GET" || match === null) return new Response("Not Found", { status: 404 });
    const roomId = match[1];
    if (roomId === undefined) return new Response("Not Found", { status: 404 });
    return env.RELAY_ROOM.getByName(roomId).fetch(request);
  },
} satisfies ExportedHandler<Env>;

function relayAttachment(socket: WebSocket): RelayAttachment {
  const value: unknown = socket.deserializeAttachment();
  if (!isRecord(value)
    || typeof value.authenticated !== "boolean"
    || typeof value.connectedAtEpochMs !== "number"
    || typeof value.roomId !== "string" || !/^[a-f0-9]{32}$/.test(value.roomId)
    || typeof value.forwardedMessages !== "number"
    || typeof value.forwardedBytes !== "number") {
    throw new Error("Relay socket attachment is invalid.");
  }
  const side = value.side === "mac" || value.side === "mobile" ? value.side : undefined;
  const tokenHash = Array.isArray(value.tokenHash)
    && value.tokenHash.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? value.tokenHash as number[]
    : undefined;
  return {
    authenticated: value.authenticated,
    connectedAtEpochMs: value.connectedAtEpochMs,
    roomId: value.roomId,
    forwardedMessages: value.forwardedMessages,
    forwardedBytes: value.forwardedBytes,
    ...(side === undefined ? {} : { side }),
    ...(tokenHash === undefined ? {} : { tokenHash }),
  };
}

function parseAuthentication(message: string): RelayAuthentication | undefined {
  let value: unknown;
  try { value = JSON.parse(message); } catch { return undefined; }
  if (!isRecord(value)
    || value.type !== "relay.authenticate"
    || value.relayProtocolVersion !== RELAY_PROTOCOL_VERSION
    || !(value.side === "mac" || value.side === "mobile")
    || typeof value.roomId !== "string" || !/^[a-f0-9]{32}$/.test(value.roomId)
    || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value.token)) {
    return undefined;
  }
  return {
    type: "relay.authenticate",
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
    side: value.side,
    roomId: value.roomId,
    token: value.token,
  };
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function log(event: string, details: Readonly<Record<string, string | number | undefined>> = {}): void {
  console.log(JSON.stringify({
    event,
    atEpochMs: Date.now(),
    ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)),
  }));
}
