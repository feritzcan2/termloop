import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";

const MAGIC = new Uint8Array([0x54, 0x4c, 0x52, 0x31]); // TLR1
const HEADER_BYTES = 4 + 1 + 8 + 24;
const TEXT = 0;
const BINARY = 1;

export type RelayDirection = "mac" | "mobile";

export type RelayPlainMessage =
  | { readonly data: string; readonly binary: false }
  | { readonly data: Uint8Array; readonly binary: true };

/// Stateful AEAD envelope for one relay WebSocket generation. The relay sees
/// only direction, sequence, nonce, and ciphertext; content kind lives inside
/// the authenticated ciphertext. Strict monotonic receive sequence rejects a
/// duplicated frame before it can reach control or terminal parsing.
export function createRelayEnvelopeCodec(
  encodedKey: string,
  outboundDirection: RelayDirection,
): {
  seal(data: string | Uint8Array, binary: boolean): Uint8Array;
  open(frame: Uint8Array): RelayPlainMessage;
} {
  const key = decodeBase64Url(encodedKey);
  if (key.byteLength !== 32) throw new Error("Relay encryption key must be 32 bytes.");
  const outbound = directionByte(outboundDirection);
  const inbound = directionByte(outboundDirection === "mac" ? "mobile" : "mac");
  let sent = 0n;
  let received = 0n;
  return {
    seal(data, binary) {
      const sequence = ++sent;
      const nonce = randomBytes(24);
      const header = headerBytes(outbound, sequence, nonce);
      const content = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const plaintext = new Uint8Array(1 + content.byteLength);
      plaintext[0] = binary ? BINARY : TEXT;
      plaintext.set(content, 1);
      const ciphertext = xchacha20poly1305(key, nonce, header).encrypt(plaintext);
      const result = new Uint8Array(header.byteLength + ciphertext.byteLength);
      result.set(header, 0);
      result.set(ciphertext, header.byteLength);
      return result;
    },
    open(frame) {
      if (frame.byteLength <= HEADER_BYTES || !matchesMagic(frame) || frame[4] !== inbound) {
        throw new Error("Relay envelope header is invalid.");
      }
      const header = frame.slice(0, HEADER_BYTES);
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const sequence = view.getBigUint64(5);
      if (sequence !== received + 1n) throw new Error("Relay envelope sequence is invalid.");
      const nonce = header.slice(13, HEADER_BYTES);
      const plaintext = xchacha20poly1305(key, nonce, header).decrypt(frame.slice(HEADER_BYTES));
      const kind = plaintext[0];
      if (kind !== TEXT && kind !== BINARY) throw new Error("Relay content kind is invalid.");
      received = sequence;
      const content = plaintext.slice(1);
      return kind === BINARY
        ? { data: content, binary: true }
        : { data: new TextDecoder().decode(content), binary: false };
    },
  };
}

function headerBytes(direction: number, sequence: bigint, nonce: Uint8Array): Uint8Array {
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = direction;
  new DataView(header.buffer).setBigUint64(5, sequence);
  header.set(nonce, 13);
  return header;
}

function matchesMagic(value: Uint8Array): boolean {
  return MAGIC.every((byte, index) => value[index] === byte);
}

function directionByte(direction: RelayDirection): number {
  return direction === "mac" ? 1 : 2;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Relay encryption key is invalid.");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  const decoded = atob(base64);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
