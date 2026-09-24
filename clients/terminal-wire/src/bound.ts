/** Framing for an authenticated connection bound to one terminal and epoch. */
export type BoundFrameFormat = { magic: string; max_payload: number; kinds: { [key: string]: number } };
export function encodeBoundFrame(format: BoundFrameFormat, kind: number, sequence: number, payload: Uint8Array): Uint8Array {
  if (format.magic.length !== 4 || !Object.values(format.kinds).includes(kind) || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 0xffffffff || payload.byteLength > format.max_payload) throw new Error("Invalid terminal frame");
  const bytes = new Uint8Array(13 + payload.byteLength);
  bytes.set(new TextEncoder().encode(format.magic)); bytes[4] = kind;
  const view = new DataView(bytes.buffer); view.setUint32(5, sequence); view.setUint32(9, payload.byteLength); bytes.set(payload, 13); return bytes;
}
export function decodeBoundFrame(format: BoundFrameFormat, bytes: Uint8Array): { kind: number; sequence: number; payload: Uint8Array } {
  if (bytes.byteLength < 13 || new TextDecoder().decode(bytes.subarray(0,4)) !== format.magic) throw new Error("Invalid terminal frame");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = bytes[4]!; const sequence = view.getUint32(5); const length = view.getUint32(9);
  if (!Object.values(format.kinds).includes(kind) || sequence === 0 || length > format.max_payload || bytes.byteLength !== 13 + length) throw new Error("Invalid terminal frame");
  return { kind, sequence, payload: bytes.subarray(13) };
}
