export const FRAME_MAGIC = "TL01";
export const KIND_INPUT = 1;
export const KIND_OUTPUT = 2;
export const KIND_GAP = 4;
export const KIND_EOF = 5;
export const KIND_REPLAY_OUTPUT = 6;
export const KIND_ATTACH = 10;
export const KIND_ACK = 11;
export const KIND_ERROR = 12;
export const KIND_DETACH = 15;
export const KIND_INPUT_ACK = 16;

const HEADER_BYTES = 41;
const encoder = new TextEncoder();

export interface DecodedTerminalFrame {
  readonly sessionId: string;
  readonly epoch: number;
  readonly sequence: bigint;
  readonly kind: number;
  readonly payload: Uint8Array;
}

export function encodeFrame(
  sessionId: string,
  epoch: number,
  sequence: bigint,
  kind: number,
  payload: Uint8Array = new Uint8Array(),
): ArrayBuffer {
  const bytes = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode(FRAME_MAGIC), 0);
  bytes.set(uuidBytes(sessionId), 4);
  view.setBigUint64(20, BigInt(epoch));
  view.setBigUint64(28, sequence);
  bytes[36] = kind;
  view.setUint32(37, payload.byteLength);
  bytes.set(payload, HEADER_BYTES);
  return bytes.buffer;
}

export function decodeFrame(bytes: Uint8Array): DecodedTerminalFrame {
  if (bytes.byteLength < HEADER_BYTES) throw new Error("Terminal frame is too short.");
  if (new TextDecoder().decode(bytes.slice(0, 4)) !== FRAME_MAGIC) {
    throw new Error("Terminal frame magic is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLength = view.getUint32(37);
  if (HEADER_BYTES + payloadLength !== bytes.byteLength) {
    throw new Error("Terminal frame length is invalid.");
  }
  return {
    sessionId: uuidString(bytes.slice(4, 20)),
    epoch: Number(view.getBigUint64(20)),
    sequence: view.getBigUint64(28),
    kind: bytes[36] ?? KIND_ERROR,
    payload: bytes.slice(HEADER_BYTES),
  };
}

export function decodeGapCount(payload: Uint8Array): number {
  if (payload.byteLength !== 8) return 1;
  const count = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0);
  return Number(count > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : count);
}

function uuidBytes(id: string): Uint8Array {
  const hex = id.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("Session id is not a UUID.");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function uuidString(bytes: Uint8Array): string {
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
