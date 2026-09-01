const FRAME_MAGIC = "TL01";
const HEADER_BYTES = 41;
const KIND_INPUT = 1;
const KIND_ENABLE_INPUT_ACK = 17;

/// Enables daemon-authored input acknowledgements only on a terminal connection
/// whose runtime discovery explicitly advertised support. Older daemons ignore
/// the unknown bounded frame, but the gateway never sends it to those runtimes.
export function enableTerminalInputAckFrame() {
  const bytes = Buffer.alloc(HEADER_BYTES);
  bytes.write(FRAME_MAGIC, 0, "ascii");
  bytes[36] = KIND_ENABLE_INPUT_ACK;
  return bytes;
}

/**
 * Extracts only the byte-free identity needed to acknowledge one terminal input
 * frame. The gateway never decodes or logs the input payload itself.
 */
export function terminalInputReceipt(bytes) {
  if (!Buffer.isBuffer(bytes)) return undefined;
  if (bytes.length < HEADER_BYTES || bytes.toString("ascii", 0, 4) !== FRAME_MAGIC) return undefined;
  if (bytes[36] !== KIND_INPUT) return undefined;
  const payloadLength = bytes.readUInt32BE(37);
  if (HEADER_BYTES + payloadLength !== bytes.length) return undefined;
  const epoch = bytes.readBigUInt64BE(20);
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return {
    sessionId: uuidString(bytes.subarray(4, 20)),
    runtimeEpoch: Number(epoch),
    frameSequence: bytes.readBigUInt64BE(28).toString(),
    inputBytes: payloadLength,
  };
}

function uuidString(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
