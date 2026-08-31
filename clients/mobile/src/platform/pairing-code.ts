import type { SavedConnection } from "./secure-connections";

const PREFIX = "TLMP1:";
const MAX_CODE_CHARS = 8 * 1024;

interface PairingPayload {
  readonly version: 1 | 2;
  readonly connectionId: string;
  readonly name: string;
  readonly protocolVersion: string;
  readonly controlUrl: string;
  readonly controlToken: string;
  readonly terminalUrl: string;
  readonly terminalToken: string;
  readonly relay?: NonNullable<SavedConnection["relay"]>;
}

/// Parse the explicit owner-generated bootstrap code. The code is intentionally
/// boring JSON behind a version prefix: it can be pasted without a camera/native
/// scanner dependency, and a future QR contains these exact bytes rather than a
/// second pairing protocol.
export function parsePairingCode(input: string): SavedConnection {
  const code = input.trim();
  if (code.length > MAX_CODE_CHARS || !code.startsWith(PREFIX)) {
    throw new Error("This is not a TermLoop Mobile pair code.");
  }
  let value: unknown;
  try {
    value = JSON.parse(code.slice(PREFIX.length));
  } catch {
    throw new Error("The pair code is malformed.");
  }
  if (!isPairingPayload(value)) throw new Error("The pair code is incomplete or unsupported.");
  return {
    id: value.connectionId,
    name: value.name,
    controlUrl: value.controlUrl,
    controlToken: value.controlToken,
    terminalUrl: value.terminalUrl,
    terminalToken: value.terminalToken,
    ...(value.relay === undefined ? {} : { relay: value.relay }),
    lastConnectedAtEpochMs: null,
    productVersion: null,
    contractIdentity: value.protocolVersion,
  };
}

function isPairingPayload(value: unknown): value is PairingPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const relay = record.relay;
  return (record.version === 1 || record.version === 2)
    && typeof record.connectionId === "string"
    && typeof record.name === "string"
    && typeof record.protocolVersion === "string"
    && typeof record.controlUrl === "string"
    && typeof record.controlToken === "string"
    && typeof record.terminalUrl === "string"
    && typeof record.terminalToken === "string"
    && (record.version === 1 ? relay === undefined : isRelayPayload(relay))
    && Object.keys(record).every((key) => [
      "version",
      "connectionId",
      "name",
      "protocolVersion",
      "controlUrl",
      "controlToken",
      "terminalUrl",
      "terminalToken",
      "relay",
    ].includes(key));
}

function isRelayPayload(value: unknown): value is NonNullable<SavedConnection["relay"]> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.url === "string"
    && typeof record.roomId === "string"
    && typeof record.token === "string"
    && typeof record.encryptionKey === "string"
    && Object.keys(record).every((key) => ["url", "roomId", "token", "encryptionKey"].includes(key));
}
