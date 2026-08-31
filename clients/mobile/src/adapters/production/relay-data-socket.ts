import type { SavedConnection } from "../../platform/secure-connections";
import type { MobileDiagnosticReporter } from "../../platform/mobile-diagnostics";
import { createRelayEnvelopeCodec } from "../../domain/relay-envelope";
import {
  dataSocketMessageBytes,
  type DataSocket,
  type DataSocketFactory,
} from "./data-socket";

const RELAY_PROTOCOL_VERSION = 1;

/// Adapts the opaque relay into an ordinary WebSocket-shaped byte stream. The
/// coordinator above it cannot tell direct and relayed paths apart, which keeps
/// reconnect, terminal replay, and control request semantics identical.
export function createRelayDataSocket(
  connectionId: string,
  relay: NonNullable<SavedConnection["relay"]>,
  socketFactory: DataSocketFactory,
  diagnostics: MobileDiagnosticReporter,
): DataSocket {
  const codec = createRelayEnvelopeCodec(relay.encryptionKey, "mobile");
  const upstream = socketFactory(relayEndpoint(relay.url, relay.roomId));
  let state = 0;
  let relayReady = false;
  let inbound = Promise.resolve();
  const exposed: DataSocket = {
    binaryType: "arraybuffer",
    get readyState() { return state; },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      if (!relayReady || state !== 1) throw new Error("Relay is not connected.");
      const binary = typeof data !== "string";
      const content = typeof data === "string"
        ? data
        : data instanceof Uint8Array ? data : new Uint8Array(data);
      upstream.send(codec.seal(content, binary));
    },
    close() {
      if (state >= 2) return;
      state = 2;
      upstream.close();
    },
  };
  upstream.binaryType = "arraybuffer";
  upstream.onopen = () => {
    try {
      upstream.send(JSON.stringify({
        type: "relay.authenticate",
        relayProtocolVersion: RELAY_PROTOCOL_VERSION,
        side: "mobile",
        roomId: relay.roomId,
        token: relay.token,
      }));
    } catch {
      upstream.close();
    }
  };
  upstream.onmessage = (event) => {
    inbound = inbound.then(async () => {
      if (!relayReady) {
        if (!isRelayReady(event.data)) throw new Error("Relay authentication was refused.");
        relayReady = true;
        state = 1;
        diagnostics.report("connection", "relay_ready", { connectionId });
        exposed.onopen?.();
        return;
      }
      if (isRelayWaiting(event.data)) {
        diagnostics.report("connection", "relay_peer_lost", { connectionId });
        upstream.close();
        return;
      }
      const message = codec.open(await dataSocketMessageBytes(event.data));
      exposed.onmessage?.({
        data: message.binary ? message.data.buffer.slice(
          message.data.byteOffset,
          message.data.byteOffset + message.data.byteLength,
        ) : message.data,
      });
    }).catch((cause: unknown) => {
      diagnostics.report("connection", "relay_message_failed", {
        connectionId,
        causeType: cause instanceof Error ? cause.name : typeof cause,
      });
      exposed.onerror?.({ type: cause instanceof Error ? cause.name : "error" });
      upstream.close();
    });
  };
  upstream.onerror = (event) => exposed.onerror?.(event);
  upstream.onclose = (event) => {
    state = 3;
    exposed.onclose?.(event);
  };
  return exposed;
}

function relayEndpoint(base: string, roomId: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(roomId)}`;
  return url.toString();
}

function isRelayReady(data: unknown): boolean {
  if (typeof data !== "string") return false;
  try {
    const value: unknown = JSON.parse(data);
    return isRecord(value)
      && value.type === "relay.ready"
      && value.relayProtocolVersion === RELAY_PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

function isRelayWaiting(data: unknown): boolean {
  if (typeof data !== "string") return false;
  try {
    const value: unknown = JSON.parse(data);
    return isRecord(value) && value.type === "relay.waiting";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
