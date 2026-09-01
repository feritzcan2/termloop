import { describe, expect, it } from "vitest";

import {
  enableTerminalInputAckFrame,
  terminalInputReceipt,
} from "../scripts/mobile-access-input-receipt.mjs";
import {
  KIND_ATTACH,
  KIND_INPUT,
  encodeFrame,
} from "../src/adapters/production/terminal-frame";

describe("mobile terminal input receipts", () => {
  it("extracts only bounded input identity without retaining payload bytes", () => {
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const input = encodeFrame(sessionId, 7, 42n, KIND_INPUT, new TextEncoder().encode("private input"));

    expect(terminalInputReceipt(Buffer.from(input))).toEqual({
      sessionId,
      runtimeEpoch: 7,
      frameSequence: "42",
      inputBytes: 13,
    });
    expect(terminalInputReceipt(Buffer.from(
      encodeFrame(sessionId, 7, 43n, KIND_ATTACH),
    ))).toBeUndefined();
    expect(terminalInputReceipt(Buffer.from([1, 2, 3]))).toBeUndefined();
  });

  it("builds the byte-free daemon acknowledgement capability frame", () => {
    const frame = enableTerminalInputAckFrame();

    expect(frame.byteLength).toBe(41);
    expect(frame.toString("ascii", 0, 4)).toBe("TL01");
    expect(frame[36]).toBe(17);
    expect(frame.readUInt32BE(37)).toBe(0);
  });
});
