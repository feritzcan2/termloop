import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

import { createRelayEnvelopeCodec } from "../src/domain/relay-envelope.ts";

const RELAY_PROTOCOL_VERSION = 1;
const MAX_RELAY_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;

export function createOutboundMobileRelay({ relay, diagnostics, acceptPeer }) {
  const health = {
    configured: relay !== undefined,
    connected: false,
    lastTransitionAtEpochMs: Date.now(),
    connectAttempts: 0,
    successfulConnections: 0,
    disconnects: 0,
    reconnectDelayMs: 0,
    lastReadyDurationMs: null,
  };
  if (relay === undefined) {
    return { health, start() {}, stop() {} };
  }
  let reconnectDelayMs = MIN_RECONNECT_MS;
  let reconnectTimer;
  let stopping = false;
  let started = false;
  const sockets = new Set();

  const connect = () => {
    if (stopping) return;
    const startedAtEpochMs = Date.now();
    const codec = createRelayEnvelopeCodec(relay.encryptionKey, "mac");
    const remote = new WebSocket(relayEndpoint(relay.url, relay.roomId), {
      maxPayload: MAX_RELAY_PAYLOAD_BYTES,
    });
    sockets.add(remote);
    let ready = false;
    let peer;
    let inbound = Promise.resolve();
    health.connectAttempts += 1;
    health.reconnectDelayMs = reconnectDelayMs;
    diagnostics.report("relay", "connection_started", { reconnectDelayMs });
    remote.once("open", () => {
      remote.send(JSON.stringify({
        type: "relay.authenticate",
        relayProtocolVersion: RELAY_PROTOCOL_VERSION,
        side: "mac",
        roomId: relay.roomId,
        token: relay.token,
      }));
    });
    remote.on("message", (data, isBinary) => {
      inbound = inbound.then(() => {
        if (!ready) {
          if (isBinary || !isRelayMessage(data, "relay.ready")) {
            throw new Error("relay authentication failed");
          }
          ready = true;
          reconnectDelayMs = MIN_RECONNECT_MS;
          health.connected = true;
          health.lastTransitionAtEpochMs = Date.now();
          health.successfulConnections += 1;
          health.reconnectDelayMs = reconnectDelayMs;
          health.lastReadyDurationMs = Date.now() - startedAtEpochMs;
          peer = new RelayPeerSocket(remote, codec);
          const connectionId = acceptPeer(peer);
          diagnostics.report("relay", "connection_ready", {
            connectionId,
            durationMs: health.lastReadyDurationMs,
          });
          return;
        }
        if (!isBinary) {
          if (isRelayMessage(data, "relay.waiting")) remote.close(1012, "relay peer disconnected");
          else throw new Error("unexpected relay text message");
          return;
        }
        const message = codec.open(new Uint8Array(rawBuffer(data)));
        peer?.receive(message.data, message.binary);
      }).catch((cause) => {
        diagnostics.report("relay", "message_failed", {
          causeType: cause instanceof Error ? cause.name : typeof cause,
        });
        remote.close(1002, "invalid relay message");
      });
    });
    remote.once("error", (error) => {
      diagnostics.report("relay", "socket_error", {
        ready,
        errorType: error?.name,
        durationMs: Date.now() - startedAtEpochMs,
      });
      remote.terminate();
    });
    remote.once("close", (code, reason) => {
      sockets.delete(remote);
      health.connected = false;
      health.lastTransitionAtEpochMs = Date.now();
      health.disconnects += 1;
      peer?.disconnected(code, reason?.toString("utf8"));
      diagnostics.report("relay", "connection_closed", {
        ready,
        closeCode: code,
        closeReasonBytes: reason?.byteLength,
        lifetimeMs: Date.now() - startedAtEpochMs,
      });
      if (stopping) return;
      const delayMs = reconnectDelayMs;
      reconnectDelayMs = Math.min(MAX_RECONNECT_MS, reconnectDelayMs * 2);
      health.reconnectDelayMs = delayMs;
      diagnostics.report("relay", "reconnect_scheduled", { delayMs });
      reconnectTimer = setTimeout(connect, delayMs);
      reconnectTimer.unref();
    });
  };

  return {
    health,
    start() {
      if (started) return;
      started = true;
      connect();
    },
    stop() {
      if (stopping) return;
      stopping = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      for (const socket of sockets) socket.close(1001, "gateway restarting");
    },
  };
}

class RelayPeerSocket extends EventEmitter {
  readyState = WebSocket.OPEN;

  constructor(remote, codec) {
    super();
    this.remote = remote;
    this.codec = codec;
  }

  send(data, options = {}) {
    if (this.readyState !== WebSocket.OPEN || this.remote.readyState !== WebSocket.OPEN) {
      throw new Error("relay peer is not connected");
    }
    const binary = options.binary ?? typeof data !== "string";
    const content = typeof data === "string" ? data : new Uint8Array(rawBuffer(data));
    this.remote.send(this.codec.seal(content, binary), { binary: true });
  }

  receive(data, binary) {
    if (this.readyState !== WebSocket.OPEN) return;
    this.emit("message", Buffer.from(data), binary);
  }

  close(code = 1000, reason = "") {
    if (this.readyState !== WebSocket.OPEN) return;
    this.readyState = WebSocket.CLOSING;
    this.remote.close(code, reason);
  }

  disconnected(code, reason) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason ?? ""));
  }
}

function relayEndpoint(base, roomId) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(roomId)}`;
  return url.toString();
}

function isRelayMessage(data, type) {
  try {
    const value = JSON.parse(rawBuffer(data).toString("utf8"));
    return value?.type === type && value.relayProtocolVersion === RELAY_PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

function rawBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  return Buffer.from(value);
}
