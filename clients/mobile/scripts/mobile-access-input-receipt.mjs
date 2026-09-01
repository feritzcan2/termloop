const FRAME_MAGIC = "TL01";
const HEADER_BYTES = 41;
const KIND_INPUT = 1;
const KIND_ENABLE_INPUT_ACK = 17;
const FRAME_KIND_NAMES = new Map([
  [1, "input"],
  [2, "output"],
  [4, "gap"],
  [5, "eof"],
  [6, "replayOutput"],
  [10, "attach"],
  [11, "attachAck"],
  [12, "error"],
  [13, "focus"],
  [14, "resizeOwnership"],
  [15, "detach"],
  [16, "inputAck"],
  [17, "enableInputAck"],
]);

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
  const frame = terminalFrameMetadata(bytes);
  if (frame === undefined || frame.frameKind !== KIND_INPUT) return undefined;
  return {
    sessionId: frame.sessionId,
    runtimeEpoch: frame.runtimeEpoch,
    frameSequence: frame.frameSequence,
    inputBytes: frame.payloadBytes,
  };
}

/// Returns bounded, byte-free protocol metadata for diagnostics. Payload bytes
/// are counted but never retained, decoded, or logged.
export function terminalFrameMetadata(bytes) {
  if (!Buffer.isBuffer(bytes)) return undefined;
  if (bytes.length < HEADER_BYTES || bytes.toString("ascii", 0, 4) !== FRAME_MAGIC) return undefined;
  const payloadLength = bytes.readUInt32BE(37);
  if (HEADER_BYTES + payloadLength !== bytes.length) return undefined;
  const epoch = bytes.readBigUInt64BE(20);
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const frameKind = bytes[36];
  return {
    sessionId: uuidString(bytes.subarray(4, 20)),
    runtimeEpoch: Number(epoch),
    frameSequence: bytes.readBigUInt64BE(28).toString(),
    frameKind,
    frameKindName: FRAME_KIND_NAMES.get(frameKind) ?? "unknown",
    payloadBytes: payloadLength,
  };
}

function uuidString(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
