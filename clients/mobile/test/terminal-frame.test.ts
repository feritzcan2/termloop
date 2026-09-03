import { describe, expect, it } from "vitest";

import {
  MOBILE_REPLAY_BUDGET_BYTES,
  MOBILE_REPLAY_CHUNK_BYTES,
  decodeReplayAck,
  replayRequestPayload,
} from "../src/adapters/production/terminal-frame";

function ack(frameCount: number, outputBytes: number): Uint8Array {
  const payload = new Uint8Array(12);
  payload.set(new TextEncoder().encode("TLRA"));
  const view = new DataView(payload.buffer);
  view.setUint32(4, frameCount);
  view.setUint32(8, outputBytes);
  return payload;
}

describe("terminal replay negotiation", () => {
  it("requests the bounded mobile replay suffix in binary attach metadata", () => {
    const request = replayRequestPayload();
    expect(new TextDecoder().decode(request.slice(0, 4))).toBe("TLRQ");
    const view = new DataView(request.buffer);
    expect(view.getUint32(4)).toBe(MOBILE_REPLAY_BUDGET_BYTES);
    expect(view.getUint32(8)).toBe(MOBILE_REPLAY_CHUNK_BYTES);
  });

  it("distinguishes a new replay ACK from an old daemon echoing the request", () => {
    expect(decodeReplayAck(replayRequestPayload())).toBeUndefined();
    expect(decodeReplayAck(ack(18, MOBILE_REPLAY_BUDGET_BYTES))).toEqual({
      frameCount: 18,
      outputBytes: MOBILE_REPLAY_BUDGET_BYTES,
    });
  });

  it("rejects metadata outside the negotiated mobile bounds", () => {
    expect(decodeReplayAck(ack(129, 1))).toBeUndefined();
    expect(decodeReplayAck(ack(1, MOBILE_REPLAY_BUDGET_BYTES + 1))).toBeUndefined();
  });
});
