export const FRAME_MAGIC = "TL01";
export const KIND_INPUT = 1;
export const KIND_OUTPUT = 2;
export const KIND_RESIZE = 3;
export const KIND_GAP = 4;
export const KIND_EOF = 5;
export const KIND_REPLAY_OUTPUT = 6;
export const KIND_ATTACH = 10;
export const KIND_ACK = 11;
export const KIND_ERROR = 12;
export const KIND_FOCUS = 13;
export const KIND_RESIZE_OWNERSHIP = 14;
export const KIND_DETACH = 15;

const encoder = new TextEncoder();

function uuidBytes(id: string): Uint8Array {
  const hex = id.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function uuidString(bytes: Uint8Array): string {
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeFrame(
  sessionId: string,
  epoch: number,
  sequence: bigint,
  kind: number,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
): ArrayBuffer {
  const bytes = new Uint8Array(41 + payload.length);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode(FRAME_MAGIC));
  bytes.set(uuidBytes(sessionId), 4);
  view.setBigUint64(20, BigInt(epoch));
  view.setBigUint64(28, sequence);
  bytes[36] = kind;
  view.setUint32(37, payload.length);
  bytes.set(payload, 41);
  return bytes.buffer;
}

export function decodeFrame(bytes: Uint8Array): {
  sessionId: string;
  epoch: number;
  kind: number;
  payload: Uint8Array;
} {
  if (bytes.byteLength < 41) throw new Error("terminal frame too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(37);
  if (41 + length > bytes.byteLength) throw new Error("terminal frame payload truncated");
  return {
    sessionId: uuidString(bytes.slice(4, 20)),
    epoch: Number(view.getBigUint64(20)),
    kind: bytes[36]!,
    payload: bytes.slice(41, 41 + length),
  };
}

export function encodeResize(rows: number, cols: number): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(4);
  const view = new DataView(payload.buffer);
  view.setUint16(0, rows);
  view.setUint16(2, cols);
  return payload;
}

export function encodeAcknowledgedBytes(bytes: number): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setBigUint64(0, BigInt(Math.max(0, Math.floor(bytes))));
  return payload;
}
