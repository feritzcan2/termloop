/// One-shot terminal input for the watch facade. The watch cannot hold a
/// WebSocket (TN3135), so the gateway bridges a single HTTPS request into the
/// binary terminal data plane: authenticate, attach, deliver the input bytes,
/// close. Frame layout mirrors the mobile client's terminal adapter (TL01).

const FRAME_MAGIC = "TL01";
const HEADER_BYTES = 41;
export const KIND_INPUT = 1;
export const KIND_ATTACH = 10;
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
    && /^[0-9a-fA-F-]{36}$/.test(value.sessionId)
    && Number.isInteger(value.runtimeEpoch) && value.runtimeEpoch >= 0
    && typeof value.text === "string"
    && value.text.trim().length > 0
    && value.text.length <= WATCH_REPLY_MAX_CHARS;
}

/// Connects, authenticates, attaches, sends the input, and resolves once the
/// bytes are flushed. Resolves false on refusal or timeout — never throws.
export function sendTerminalInput(WebSocketCtor, terminalUrl, terminalToken, reply, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    let settled = false;
    let authenticated = false;
    const socket = new WebSocketCtor(terminalUrl, { maxPayload: 4 * 1024 * 1024 });
    const finish = (delivered) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* Already closing. */ }
      resolve(delivered);
    };
    const timer = setTimeout(() => {
      try { socket.terminate?.(); } catch { /* Already gone. */ }
      finish(false);
    }, timeoutMs);
    socket.once("open", () => socket.send(terminalAuthBytes(terminalToken)));
    socket.on("message", (data) => {
      if (authenticated) return;
      const text = Buffer.from(data).toString("utf8");
      if (text !== "TLOK") return finish(false);
      authenticated = true;
      let sequence = 1n;
      socket.send(encodeTerminalFrame(reply.sessionId, reply.runtimeEpoch, sequence++, KIND_ATTACH));
      const [paste, submit] = replyInputSequence(reply.text);
      socket.send(
        encodeTerminalFrame(reply.sessionId, reply.runtimeEpoch, sequence++, KIND_INPUT, paste),
        (pasteError) => {
          if (pasteError) return finish(false);
          socket.send(
            encodeTerminalFrame(reply.sessionId, reply.runtimeEpoch, sequence++, KIND_INPUT, submit),
            (submitError) => finish(!submitError),
          );
        },
      );
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
