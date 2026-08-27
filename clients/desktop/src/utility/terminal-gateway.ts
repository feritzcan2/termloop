import WebSocket, { type RawData } from "ws";
import {
  ACCESS_PROTOCOL_IDENTITY,
  CONTRACT_IDENTITY,
  type AccessAuthenticated,
  type AccessChallenge,
  type AccessProtocolError,
} from "@termloop/contract/current";
import { signAccessChallenge, type AccessCredential } from "../access-auth.js";
import {
  FRAME_MAGIC,
  KIND_ACK,
  KIND_ATTACH,
  KIND_DETACH,
  KIND_ERROR,
  KIND_FOCUS,
  KIND_INPUT,
  KIND_RESIZE,
  KIND_RESIZE_OWNERSHIP,
  decodeFrame,
  encodeFrame,
  encodeAcknowledgedBytes,
  encodeResize,
} from "./terminal-frame.js";

const encoder = new TextEncoder();
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const INITIAL_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 2_000;
const INITIAL_ATTACH_RETRY_MS = 100;
const MAX_ATTACH_RETRY_MS = 1_000;
const INITIAL_INPUT_CREDIT_BYTES = 64 * 1024;

type PortMessage =
  | { type: "credit"; bytes: number; startupReplay?: boolean }
  | { type: "input"; data: ArrayBuffer }
  | { type: "resize"; rows: number; cols: number }
  | { type: "focus" }
  | { type: "detach" };

type QueuedFrame = { kind: number; data: ArrayBuffer; bytes: number };
type Attachment = {
  sessionId: string;
  runtimeEpoch: number;
  sequence: bigint;
  dimensions: { rows: number; cols: number } | undefined;
  port: Electron.MessagePortMain;
  credit: number;
  queuedBytes: number;
  queue: QueuedFrame[];
  gapPending: boolean;
  attached: boolean;
  attachRetryMs: number;
  attachRetryTimer: ReturnType<typeof setTimeout> | undefined;
};

let terminalUrl: string | undefined;
let terminalToken: string | undefined;
let connectionKind: "local" | "remote" = "local";
let accessProfileId: string | undefined;
let accessCredential: AccessCredential | undefined;
let socket: WebSocket | undefined;
let connecting: Promise<void> | undefined;
let reconnectDelay = INITIAL_RECONNECT_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const attachments = new Map<string, Attachment>();
const MAX_TERMINAL_MESSAGE_BYTES = 8 * 1024 * 1024;

process.parentPort.on("message", (event) => {
  const message = event.data as {
    type?: string;
    connectionKind?: "local" | "remote";
    terminalUrl?: string;
    terminalToken?: string;
    accessProfileId?: string;
    accessCredential?: AccessCredential;
    sessionId?: string;
    runtimeEpoch?: number;
  };
  if (message.type === "configure" && message.terminalUrl && message.terminalToken) {
    const nextKind = message.connectionKind ?? "local";
    const changed = terminalUrl !== message.terminalUrl
      || terminalToken !== message.terminalToken
      || connectionKind !== nextKind
      || accessProfileId !== message.accessProfileId;
    terminalUrl = message.terminalUrl;
    terminalToken = message.terminalToken;
    connectionKind = nextKind;
    accessProfileId = message.accessProfileId;
    accessCredential = message.accessCredential;
    if (changed && socket) {
      socket.close();
      socket = undefined;
    }
    void ensureConnected();
    return;
  }
  if (message.type === "attach" && message.sessionId && typeof message.runtimeEpoch === "number") {
    const port = event.ports[0];
    if (!port) return;
    addAttachment(message.sessionId, message.runtimeEpoch, port);
    void ensureConnected();
  }
});

function addAttachment(sessionId: string, runtimeEpoch: number, port: Electron.MessagePortMain): void {
  const previous = attachments.get(sessionId);
  if (previous) removeAttachment(sessionId, previous.port);
  const attachment: Attachment = {
    sessionId,
    runtimeEpoch,
    sequence: 1n,
    dimensions: undefined,
    port,
    credit: 0,
    queuedBytes: 0,
    queue: [],
    gapPending: false,
    attached: false,
    attachRetryMs: INITIAL_ATTACH_RETRY_MS,
    attachRetryTimer: undefined,
  };
  attachments.set(sessionId, attachment);
  port.on("message", (event) => {
    if (!event.data || typeof event.data !== "object" || !("type" in event.data)) return;
    handlePortMessage(attachment, event.data as PortMessage);
  });
  port.on("close", () => removeAttachment(sessionId, port));
  port.start();
  port.postMessage({ type: "inputCredit", bytes: INITIAL_INPUT_CREDIT_BYTES });
  port.postMessage({ type: "state", state: socket?.readyState === WebSocket.OPEN ? "connected" : "connecting" });
  if (socket?.readyState === WebSocket.OPEN) sendAttach(attachment);
}

function removeAttachment(sessionId: string, port: Electron.MessagePortMain): void {
  const current = attachments.get(sessionId);
  if (current?.port !== port) return;
  clearAttachmentRetry(current);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(encodeFrame(
      current.sessionId,
      current.runtimeEpoch,
      current.sequence++,
      KIND_DETACH,
    ));
  }
  attachments.delete(sessionId);
  port.close();
}

function handlePortMessage(attachment: Attachment, message: PortMessage): void {
  if (message.type === "detach") {
    removeAttachment(attachment.sessionId, attachment.port);
    return;
  }
  if (message.type === "credit") {
    attachment.credit = Math.min(MAX_QUEUED_BYTES, attachment.credit + Math.max(0, message.bytes));
    if (message.startupReplay && message.bytes > 0 && socket?.readyState === WebSocket.OPEN) {
      socket.send(encodeFrame(
        attachment.sessionId,
        attachment.runtimeEpoch,
        attachment.sequence++,
        KIND_ACK,
        encodeAcknowledgedBytes(message.bytes),
      ));
    }
    flush(attachment);
    return;
  }
  if (message.type === "input") {
    const payload = Uint8Array.from(new Uint8Array(message.data));
    if (socket?.readyState !== WebSocket.OPEN) {
      attachment.port.postMessage({ type: "inputCredit", bytes: payload.byteLength });
      attachment.port.postMessage({ type: "inputRejected", message: "terminal connection is unavailable" });
      return;
    }
    socket.send(
      encodeFrame(attachment.sessionId, attachment.runtimeEpoch, attachment.sequence++, KIND_INPUT, payload),
      (error) => {
        attachment.port.postMessage({ type: "inputCredit", bytes: payload.byteLength });
        if (error) attachment.port.postMessage({ type: "inputRejected", message: "terminal input could not be delivered" });
      },
    );
  } else if (message.type === "resize") {
    attachment.dimensions = { rows: message.rows, cols: message.cols };
    if (socket?.readyState === WebSocket.OPEN) sendResize(attachment);
  } else if (message.type === "focus" && socket?.readyState === WebSocket.OPEN) {
    socket.send(encodeFrame(
      attachment.sessionId,
      attachment.runtimeEpoch,
      attachment.sequence++,
      KIND_FOCUS,
    ));
  }
}

async function ensureConnected(): Promise<void> {
  if (!terminalUrl || !terminalToken || attachments.size === 0) return;
  if (connectionKind === "remote" && (!accessProfileId || !accessCredential)) return;
  if (socket?.readyState === WebSocket.OPEN || connecting) return connecting;
  connecting = connect().finally(() => {
    connecting = undefined;
    // A runtime replacement can detach the last terminal and attach its
    // successor while this connection attempt is settling. If the attempt
    // failed during that empty interval, its retry was intentionally skipped;
    // schedule it now that an attachment is waiting.
    if (attachments.size > 0 && socket?.readyState !== WebSocket.OPEN) {
      scheduleReconnect();
    }
  });
  return connecting;
}

async function connect(): Promise<void> {
  const configuredUrl = terminalUrl;
  const configuredToken = terminalToken;
  const configuredKind = connectionKind;
  const configuredProfileId = accessProfileId;
  const configuredCredential = accessCredential;
  if (!configuredUrl || !configuredToken) return;
  if (configuredKind === "remote" && (!configuredProfileId || !configuredCredential)) return;
  broadcastState("connecting");
  const nextSocket = new WebSocket(configuredUrl, { maxPayload: MAX_TERMINAL_MESSAGE_BYTES });
  nextSocket.binaryType = "arraybuffer";
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("terminal gateway authentication timed out")), 5_000);
      const fail = () => reject(new Error("terminal gateway connection failed"));
      let phase: "accessChallenge" | "accessAuthenticated" | "terminal" = configuredKind === "remote"
        ? "accessChallenge"
        : "terminal";
      const sendTerminalAuthentication = (token: string) => {
        const auth = new Uint8Array(4 + token.length);
        auth.set(encoder.encode(FRAME_MAGIC));
        auth.set(encoder.encode(token), 4);
        nextSocket.send(auth);
      };
      nextSocket.once("error", fail);
      nextSocket.once("close", fail);
      nextSocket.once("open", () => {
        if (phase === "terminal") sendTerminalAuthentication(configuredToken);
      });
      nextSocket.on("message", function authenticate(raw, binary) {
        const response = rawText(raw);
        if (phase === "accessChallenge") {
          if (binary) {
            reject(new Error("terminal access challenge framing is invalid"));
            return;
          }
          if (!configuredCredential) {
            reject(new Error("terminal access credential is unavailable"));
            return;
          }
          let challenge: AccessChallenge;
          try { challenge = JSON.parse(response) as AccessChallenge; } catch { reject(new Error("terminal access challenge is invalid")); return; }
          if (challenge.kind !== "challenge"
            || challenge.protocolVersion !== ACCESS_PROTOCOL_IDENTITY
            || challenge.controlProtocolVersion !== CONTRACT_IDENTITY
            || challenge.channel !== "terminal"
            || challenge.serverFingerprint !== configuredCredential?.serverFingerprint) {
            reject(new Error("terminal access challenge is invalid"));
            return;
          }
          phase = "accessAuthenticated";
          nextSocket.send(JSON.stringify({
            kind: "authenticate",
            protocolVersion: ACCESS_PROTOCOL_IDENTITY,
            deviceId: configuredCredential.deviceId,
            signature: signAccessChallenge(
              configuredCredential.privateKey,
              challenge.serverFingerprint,
              "terminal",
              challenge.nonce,
            ),
          }));
          return;
        }
        if (phase === "accessAuthenticated") {
          if (binary) {
            reject(new Error("terminal access authentication framing is invalid"));
            return;
          }
          let authenticated: AccessAuthenticated | AccessProtocolError;
          try { authenticated = JSON.parse(response) as AccessAuthenticated | AccessProtocolError; } catch { reject(new Error("terminal access authentication is invalid")); return; }
          if (authenticated.kind === "error") {
            reject(new Error(authenticated.message));
            return;
          }
          if (authenticated.kind !== "authenticated" || authenticated.protocolVersion !== ACCESS_PROTOCOL_IDENTITY) {
            reject(new Error("terminal access authentication is invalid"));
            return;
          }
          phase = "terminal";
          sendTerminalAuthentication(authenticated.connectionToken);
          return;
        }
        if (!binary) {
          reject(new Error("terminal authentication framing is invalid"));
          return;
        }
        if (response !== "TLOK") {
          if (response === "TLAUTH") reject(new Error("terminal gateway authentication failed"));
          return;
        }
        clearTimeout(timeout);
        nextSocket.off("message", authenticate);
        nextSocket.off("error", fail);
        nextSocket.off("close", fail);
        resolve();
      });
    });
  } catch {
    nextSocket.close();
    broadcastState("connectionLost");
    process.parentPort.postMessage({ type: "state", state: "connectionLost" });
    scheduleReconnect();
    return;
  }
  if (configuredUrl !== terminalUrl
    || configuredToken !== terminalToken
    || configuredKind !== connectionKind
    || configuredProfileId !== accessProfileId) {
    nextSocket.close();
    scheduleReconnect();
    return;
  }
  socket = nextSocket;
  reconnectDelay = INITIAL_RECONNECT_MS;
  nextSocket.on("message", (raw, binary) => {
    if (binary) handleSocketMessage(raw);
    else nextSocket.close();
  });
  nextSocket.once("close", () => handleSocketClosed(nextSocket));
  nextSocket.once("error", () => handleSocketClosed(nextSocket));
  broadcastState("connected");
  process.parentPort.postMessage({ type: "state", state: "connected" });
  for (const attachment of attachments.values()) sendAttach(attachment);
}

function handleSocketClosed(closed: WebSocket): void {
  if (socket !== closed) return;
  socket = undefined;
  for (const attachment of attachments.values()) {
    clearAttachmentRetry(attachment);
    attachment.attached = false;
  }
  broadcastState("connectionLost");
  process.parentPort.postMessage({ type: "state", state: "connectionLost" });
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer || attachments.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * 2);
    void ensureConnected();
  }, reconnectDelay);
}

function sendAttach(attachment: Attachment): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  clearAttachmentRetry(attachment);
  attachment.attached = false;
  socket?.send(encodeFrame(
    attachment.sessionId,
    attachment.runtimeEpoch,
    attachment.sequence++,
    KIND_ATTACH,
  ));
  if (attachment.dimensions) sendResize(attachment);
}

function sendResize(attachment: Attachment): void {
  if (!attachment.dimensions) return;
  socket?.send(encodeFrame(
    attachment.sessionId,
    attachment.runtimeEpoch,
    attachment.sequence++,
    KIND_RESIZE,
    encodeResize(attachment.dimensions.rows, attachment.dimensions.cols),
  ));
}

function handleSocketMessage(raw: RawData): void {
  const bytes = rawBytes(raw);
  let frame: ReturnType<typeof decodeFrame>;
  try {
    frame = decodeFrame(bytes);
  } catch {
    return;
  }
  const attachment = attachments.get(frame.sessionId);
  if (!attachment || attachment.runtimeEpoch !== frame.epoch) return;
  if (frame.kind === KIND_ERROR && !attachment.attached) {
    // A resume projection can reach the desktop just before its replacement
    // PTY is registered. Keep that attach race out of terminal scrollback and
    // retry only this logical attachment; the WebSocket and other Sessions
    // remain healthy. Once ACKed, later errors are real terminal errors and
    // continue through the normal frame path below.
    scheduleAttachmentRetry(attachment);
    return;
  }
  if (frame.kind !== KIND_ERROR) {
    attachment.attached = true;
    attachment.attachRetryMs = INITIAL_ATTACH_RETRY_MS;
    clearAttachmentRetry(attachment);
  }
  if (frame.kind === KIND_RESIZE_OWNERSHIP) {
    attachment.port.postMessage({ type: "resizeOwnership", active: frame.payload[0] === 1 });
    return;
  }
  const standalone = Uint8Array.from(frame.payload).buffer;
  enqueue(attachment, { kind: frame.kind, data: standalone, bytes: standalone.byteLength });
}

function scheduleAttachmentRetry(attachment: Attachment): void {
  if (attachment.attachRetryTimer || attachment.attached) return;
  const delay = attachment.attachRetryMs;
  attachment.attachRetryMs = Math.min(MAX_ATTACH_RETRY_MS, delay * 2);
  attachment.attachRetryTimer = setTimeout(() => {
    attachment.attachRetryTimer = undefined;
    if (attachments.get(attachment.sessionId) !== attachment || attachment.attached) return;
    if (socket?.readyState === WebSocket.OPEN) sendAttach(attachment);
  }, delay);
}

function clearAttachmentRetry(attachment: Attachment): void {
  if (attachment.attachRetryTimer) clearTimeout(attachment.attachRetryTimer);
  attachment.attachRetryTimer = undefined;
}

function enqueue(attachment: Attachment, frame: QueuedFrame): void {
  while (attachment.queuedBytes + frame.bytes > MAX_QUEUED_BYTES && attachment.queue.length > 0) {
    const dropped = attachment.queue.shift()!;
    attachment.queuedBytes -= dropped.bytes;
    attachment.gapPending = true;
  }
  if (frame.bytes > MAX_QUEUED_BYTES) {
    attachment.gapPending = true;
    return;
  }
  attachment.queue.push(frame);
  attachment.queuedBytes += frame.bytes;
  flush(attachment);
}

function flush(attachment: Attachment): void {
  if (attachment.gapPending && attachment.credit > 0) {
    attachment.port.postMessage({ type: "gap" });
    attachment.gapPending = false;
  }
  while (attachment.queue.length > 0) {
    const frame = attachment.queue[0]!;
    if (attachment.credit < frame.bytes) break;
    attachment.queue.shift();
    attachment.queuedBytes -= frame.bytes;
    attachment.credit -= frame.bytes;
    attachment.port.postMessage({ type: "frame", kind: frame.kind, data: frame.data });
  }
}

function broadcastState(state: "connecting" | "connected" | "connectionLost"): void {
  for (const attachment of attachments.values()) attachment.port.postMessage({ type: "state", state });
}

function rawText(raw: RawData): string {
  return new TextDecoder().decode(rawBytes(raw));
}

function rawBytes(raw: RawData): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Uint8Array.from(Buffer.concat(raw));
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}
