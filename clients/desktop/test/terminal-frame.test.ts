import { describe, expect, it } from "vitest";
import {
  KIND_DETACH,
  KIND_OUTPUT,
  decodeFrame,
  encodeAcknowledgedBytes,
  encodeFrame,
  decodeReplayAck,
  replayRequestPayload,
  replayMouseModesSequence,
} from "../src/utility/terminal-frame.js";

describe("terminal frame", () => {
  it("negotiates wheel state while keeping legacy replay framing compatible", () => {
    const request = replayRequestPayload();
    expect(request.length).toBe(12);
    expect(new DataView(request.buffer).getUint32(8)).toBe(0x80000000 + 64 * 1024);
    const payload = new Uint8Array(16);
    payload.set(new TextEncoder().encode("TLRA"));
    const view = new DataView(payload.buffer);
    view.setUint32(4, 2); view.setUint32(8, 100); view.setUint32(12, 0x104);
    expect(decodeReplayAck(payload)).toEqual({ frames: 2, bytes: 100, mouseModes: 0x104 });
    expect(decodeReplayAck(payload.slice(0, 12))).toEqual({ frames: 2, bytes: 100 });
    expect(new TextDecoder().decode(replayMouseModesSequence(0x104))).toContain("\x1b[?1003h\x1b[?1006h");
    view.setUint32(12, 5);
    expect(decodeReplayAck(payload)).toBeUndefined();
    view.setUint32(12, 0x204);
    expect(decodeReplayAck(payload)).toBeUndefined();
  });
  it("round-trips binary output without JSON or base64", () => {
    const sessionId = "123e4567-e89b-12d3-a456-426614174000";
    const payload = new TextEncoder().encode("hello\u0000terminal");
    const decoded = decodeFrame(new Uint8Array(encodeFrame(sessionId, 42, 7n, KIND_OUTPUT, payload)));
    expect(decoded.sessionId).toBe(sessionId);
    expect(decoded.epoch).toBe(42);
    expect(decoded.kind).toBe(KIND_OUTPUT);
    expect([...decoded.payload]).toEqual([...payload]);
  });

  it("encodes renderer-drained byte acknowledgements as bounded binary metadata", () => {
    const payload = encodeAcknowledgedBytes(1_048_576);
    expect(payload.byteLength).toBe(8);
    expect(new DataView(payload.buffer).getBigUint64(0)).toBe(1_048_576n);
  });

  it("encodes an explicit detach without terminal payload bytes", () => {
    const sessionId = "123e4567-e89b-12d3-a456-426614174000";
    const decoded = decodeFrame(new Uint8Array(encodeFrame(sessionId, 42, 8n, KIND_DETACH)));
    expect(decoded.kind).toBe(KIND_DETACH);
    expect(decoded.payload.byteLength).toBe(0);
  });
});
