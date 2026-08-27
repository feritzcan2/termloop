import { WebSocket } from "ws";

const FRAME_MAGIC = "TL01";
const HEADER_BYTES = 41;
const KIND_OUTPUT = 2;
const KIND_EOF = 5;
const KIND_REPLAY_OUTPUT = 6;
const KIND_ATTACH = 10;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PREVIEW_CHARACTERS = 420;
const PREVIEW_TIMEOUT_MS = 800;
const PREVIEW_QUIET_MS = 120;
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/**
 * Reads only the daemon's bounded in-memory replay for one Session, then detaches.
 * No terminal bytes are written to disk and a missing/slow replay simply leaves the
 * notification on its status fallback.
 */
export function readTerminalNotificationPreview(runtime, notification) {
  return new Promise((resolve) => {
    let socket;
    let authenticated = false;
    let settled = false;
    let quietTimer;
    const chunks = [];
    let bytes = 0;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      resolve(notificationPreview(chunks, notification.kind));
    };
    const timeout = setTimeout(finish, PREVIEW_TIMEOUT_MS);

    try {
      socket = new WebSocket(runtime.terminalUrl, { maxPayload: 4 * 1024 * 1024 });
    } catch {
      finish();
      return;
    }
    socket.once("open", () => {
      socket.send(Buffer.concat([Buffer.from(FRAME_MAGIC), Buffer.from(runtime.terminalToken)]));
    });
    socket.on("message", (data, isBinary) => {
      const raw = rawBuffer(data);
      if (!authenticated) {
        if (raw.toString("utf8") !== "TLOK") return;
        authenticated = true;
        try {
          socket.send(encodeTerminalFrame(
            notification.sessionId,
            notification.runtimeEpoch,
            1n,
            KIND_ATTACH,
          ));
        } catch {
          finish();
        }
        return;
      }
      if (!isBinary) return;
      const frame = decodeTerminalFrame(raw);
      if (frame === undefined || frame.sessionId !== notification.sessionId) return;
      if (frame.kind === KIND_EOF) {
        finish();
        return;
      }
      if (frame.kind !== KIND_REPLAY_OUTPUT && frame.kind !== KIND_OUTPUT) return;
      appendBounded(chunks, frame.payload, bytes);
      bytes = Math.min(MAX_PREVIEW_BYTES, bytes + frame.payload.length);
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, PREVIEW_QUIET_MS);
    });
    socket.once("error", finish);
    socket.once("close", finish);
  });
}

/** Produces a bounded human-readable excerpt from raw PTY replay bytes. */
export function notificationPreview(chunks, kind) {
  if (!Array.isArray(chunks) || chunks.length === 0) return undefined;
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  const candidates = readableCandidates(text);
  if (candidates.length === 0) return undefined;

  let chosen = candidates.slice(-3);
  if (kind === "needsInput") {
    const question = candidates.findLast((line) => line.includes("?"));
    if (question !== undefined) chosen = [question];
  }
  const result = redactPreview(chosen.join("\n"));
  if (result.length <= MAX_PREVIEW_CHARACTERS) return result;
  return `${result.slice(0, MAX_PREVIEW_CHARACTERS - 1).trimEnd()}…`;
}

export function encodeTerminalFrame(sessionId, epoch, sequence, kind, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  const bytes = Buffer.alloc(HEADER_BYTES + body.length);
  bytes.write(FRAME_MAGIC, 0, "ascii");
  uuidBytes(sessionId).copy(bytes, 4);
  bytes.writeBigUInt64BE(BigInt(epoch), 20);
  bytes.writeBigUInt64BE(BigInt(sequence), 28);
  bytes[36] = kind;
  bytes.writeUInt32BE(body.length, 37);
  body.copy(bytes, HEADER_BYTES);
  return bytes;
}

function decodeTerminalFrame(bytes) {
  if (bytes.length < HEADER_BYTES || bytes.toString("ascii", 0, 4) !== FRAME_MAGIC) return undefined;
  const payloadLength = bytes.readUInt32BE(37);
  if (HEADER_BYTES + payloadLength !== bytes.length) return undefined;
  return {
    sessionId: uuidString(bytes.subarray(4, 20)),
    kind: bytes[36],
    payload: bytes.subarray(HEADER_BYTES),
  };
}

function appendBounded(chunks, payload, currentBytes) {
  if (payload.length >= MAX_PREVIEW_BYTES) {
    chunks.splice(0, chunks.length, payload.subarray(payload.length - MAX_PREVIEW_BYTES));
    return;
  }
  chunks.push(Buffer.from(payload));
  let overflow = currentBytes + payload.length - MAX_PREVIEW_BYTES;
  while (overflow > 0 && chunks.length > 0) {
    const first = chunks[0];
    if (first.length <= overflow) {
      overflow -= first.length;
      chunks.shift();
    } else {
      chunks[0] = first.subarray(overflow);
      overflow = 0;
    }
  }
}

function readableCandidates(value) {
  const osc = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, "g");
  const cursor = new RegExp(`${ESC}\\[[0-?]*[ -/]*[ABCDEFGHJKSTfdr]`, "g");
  const csi = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
  const otherEscape = new RegExp(`${ESC}(?:[ -/][@-~]|[@-Z0-9=><])`, "g");
  const controls = new RegExp(`[${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}${String.fromCharCode(0x0b)}-${String.fromCharCode(0x0c)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`, "g");
  const cleaned = value
    .replace(osc, "")
    .replace(cursor, "\n")
    .replace(csi, "")
    .replace(otherEscape, "")
    .replace(controls, "")
    .replaceAll("\r", "\n");
  const seen = new Set();
  const result = [];
  for (const raw of cleaned.split("\n")) {
    const line = raw.replace(/\s+/gu, " ").trim();
    if (!usefulLine(line) || seen.has(line)) continue;
    seen.add(line);
    result.push(line);
  }
  return result;
}

function usefulLine(line) {
  if (line.length < 4 || !/[\p{L}\p{N}]/u.test(line)) return false;
  if (/^(?:Claude Code|OpenAI Codex|Tip:|Working\(|esc to interrupt|context left|tokens? used)/iu.test(line)) return false;
  if (/^[─━═│┃┌┐└┘╭╮╰╯┬┴├┤┼<>›❯._\-\s]+$/u.test(line)) return false;
  return true;
}

function redactPreview(value) {
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/giu, "[secret]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu, "Bearer [secret]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[secret]")
    .replace(/\b[0-9a-f]{48,}\b/giu, "[secret]");
}

function uuidBytes(id) {
  const hex = String(id).replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("Session id is not a UUID.");
  return Buffer.from(hex, "hex");
}

function uuidString(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rawBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  return Buffer.from(value);
}
