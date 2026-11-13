import { enableTerminalInputAckFrame, terminalFrameMetadata } from "./mobile-access-input-receipt.mjs";

/// One-shot terminal input for the watch facade. The watch cannot hold a
/// WebSocket (TN3135), so the gateway bridges a single HTTPS request into the
/// binary terminal data plane: authenticate, attach, deliver the input bytes,
/// close. Frame layout mirrors the mobile client's terminal adapter (TL01).

const FRAME_MAGIC = "TL01";
const HEADER_BYTES = 41;
export const KIND_INPUT = 1;
export const KIND_ATTACH = 10;
const KIND_EOF = 5;
const KIND_ACK = 11;
const KIND_ERROR = 12;
const KIND_INPUT_ACK = 16;
export const WATCH_REPLY_MAX_CHARS = 4096;

export function encodeTerminalFrame(sessionId, epoch, sequence, kind, payload = new Uint8Array()) {
  const bytes = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(FRAME_MAGIC), 0);
  bytes.set(uuidBytes(sessionId), 4);
  view.setBigUint64(20, BigInt(epoch));
  view.setBigUint64(28, BigInt(sequence));
  bytes[36] = kind;
  view.setUint32(37, payload.byteLength);
  bytes.set(payload, HEADER_BYTES);
  return bytes;
}

export function terminalAuthBytes(token) {
  return new TextEncoder().encode(`${FRAME_MAGIC}${token}`);
}

/// A dictated reply becomes one bracketed paste followed by a separate Enter
/// write. Interactive Agent editors must see submit outside the paste frame.
export function replyInputSequence(text) {
  const clean = [...text]
    .filter((ch) => ch === "\n" || ch >= " ")
    .join("")
    .slice(0, WATCH_REPLY_MAX_CHARS);
  const content = clean.replaceAll("\n", " ");
  return [
    new TextEncoder().encode(`\u001b[200~${content}\u001b[201~`),
    new Uint8Array([13]),
  ];
}

// Retained for focused sanitizer tests; production delivery uses the framed
// two-write sequence above.
export function replyInputBytes(text) {
  const clean = [...text]
    .filter((ch) => ch === "\n" || ch >= " ")
    .join("")
    .slice(0, WATCH_REPLY_MAX_CHARS);
  return new TextEncoder().encode(`${clean.replaceAll("\n", " ")}\r`);
}

export function validWatchReply(value) {
  return typeof value === "object" && value !== null
    && typeof value.sessionId === "string"
    && /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(value.sessionId)
    && Number.isSafeInteger(value.runtimeEpoch) && value.runtimeEpoch >= 0
    && typeof value.text === "string"
    && value.text.trim().length > 0
    && value.text.length <= WATCH_REPLY_MAX_CHARS;
}

/// Requires daemon-authored PTY receipts for both writes. Socket flush alone
/// never confirms input, and unknown outcomes never replay content or Enter.
/// Older daemons without receipts refuse before any terminal input is sent.
export function sendTerminalInput(
  WebSocketCtor, terminalUrl, terminalToken, reply,
  { timeoutMs = 8_000, inputAckSupported = false } = {},
) {
  if (!inputAckSupported || !validWatchReply(reply)) return Promise.resolve(false);
  return sendTerminalWrites(WebSocketCtor, terminalUrl, terminalToken, reply, replyInputSequence(reply.text), timeoutMs);
}

/// Provider approval dialogs (Claude Code, Codex) accept their highlighted "Yes"
/// on Enter and decline on Escape, so one key answers either without guessing
/// option numbers that differ between providers and versions.
export const AGENT_DECISION_KEYS = Object.freeze({
  approve: Object.freeze([13]),
  deny: Object.freeze([27]),
});

export function validAgentDecision(value) {
  return typeof value === "object" && value !== null
    && typeof value.sessionId === "string"
    && /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(value.sessionId)
    && Number.isSafeInteger(value.runtimeEpoch) && value.runtimeEpoch >= 0
    && Object.hasOwn(AGENT_DECISION_KEYS, value.decision);
}

/// Sends one acknowledged approval key. Callers must first prove the Agent is
/// still awaiting input, or an Enter could submit whatever sits in its editor.
export function sendAgentDecision(
  WebSocketCtor, terminalUrl, terminalToken, decision,
  { timeoutMs = 8_000, inputAckSupported = false } = {},
) {
  if (!inputAckSupported || !validAgentDecision(decision)) return Promise.resolve(false);
  return sendTerminalWrites(WebSocketCtor, terminalUrl, terminalToken, decision, [
    new Uint8Array(AGENT_DECISION_KEYS[decision.decision]),
  ], timeoutMs);
}

function sendTerminalWrites(WebSocketCtor, terminalUrl, terminalToken, reply, writes, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let phase = "auth";
    let written = 0;
    let socket;
    const finish = (delivered) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* Already closing. */ }
      resolve(delivered);
    };
    const timer = setTimeout(() => {
      finish(false);
      try { socket?.terminate?.(); } catch { /* Already gone. */ }
    }, timeoutMs);
    const send = (bytes) => {
      if (settled) return;
      try {
        socket.send(bytes, (error) => { if (error) finish(false); });
      } catch { finish(false); }
    };
    try {
      socket = new WebSocketCtor(terminalUrl, { maxPayload: 4 * 1024 * 1024 });
    } catch { finish(false); return; }
    socket.once("open", () => send(terminalAuthBytes(terminalToken)));
    socket.on("message", (data) => {
      if (settled) return;
      const bytes = Buffer.from(data);
      if (phase === "auth") {
        if (bytes.toString("utf8") !== "TLOK") return finish(false);
        phase = "attach";
        send(enableTerminalInputAckFrame());
        send(encodeTerminalFrame(reply.sessionId, reply.runtimeEpoch, 1n, KIND_ATTACH));
        return;
      }
      const frame = terminalFrameMetadata(bytes);
      if (frame === undefined) return finish(false);
      if (frame.sessionId !== reply.sessionId.toLowerCase() || frame.runtimeEpoch !== reply.runtimeEpoch) return;
      if (frame.frameKind === KIND_ERROR || frame.frameKind === KIND_EOF) return finish(false);
      if (frame.payloadBytes !== 0) return;
      // Each write waits for the daemon's PTY receipt of the previous one.
      if (phase === "attach" && frame.frameKind === KIND_ACK && frame.frameSequence === "1") {
        phase = "write";
        send(encodeTerminalFrame(reply.sessionId, reply.runtimeEpoch, 2n, KIND_INPUT, writes[0]));
      } else if (phase === "write" && frame.frameKind === KIND_INPUT_ACK
        && frame.frameSequence === String(written + 2)) {
        written += 1;
        if (written === writes.length) return finish(true);
        send(encodeTerminalFrame(
          reply.sessionId, reply.runtimeEpoch, BigInt(written + 2), KIND_INPUT, writes[written],
        ));
      }
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

function uuidBytes(id) {
  const hex = id.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("session id is not a UUID");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
