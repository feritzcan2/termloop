import { CONTRACT_IDENTITY } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";

import { parsePairingCode } from "../src/platform/pairing-code";

const payload = {
  version: 1,
  connectionId: "mac-1234",
  name: "Ferit's Mac",
  protocolVersion: CONTRACT_IDENTITY,
  controlUrl: "ws://127.0.0.1:48100/control",
  controlToken: "read-only-token-1234567890",
  terminalUrl: "ws://127.0.0.1:48100/terminal",
  terminalToken: "terminal-token-1234567890",
};

describe("mobile pair code", () => {
  it("maps one versioned pasted payload into a secure connection record", () => {
    expect(parsePairingCode(`TLMP1:${JSON.stringify(payload)}`)).toEqual({
      id: payload.connectionId,
      name: payload.name,
      controlUrl: payload.controlUrl,
      controlToken: payload.controlToken,
      terminalUrl: payload.terminalUrl,
      terminalToken: payload.terminalToken,
      lastConnectedAtEpochMs: null,
      productVersion: null,
      contractIdentity: CONTRACT_IDENTITY,
    });
  });

  it("rejects unknown fields and unsupported versions", () => {
    expect(() => parsePairingCode(`TLMP1:${JSON.stringify({ ...payload, extra: true })}`))
      .toThrow("incomplete or unsupported");
    expect(() => parsePairingCode(`TLMP1:${JSON.stringify({ ...payload, version: 2 })}`))
      .toThrow("incomplete or unsupported");
    expect(() => parsePairingCode(`TLMP1:${JSON.stringify({ ...payload, version: 3 })}`))
      .toThrow("incomplete or unsupported");
  });
});
