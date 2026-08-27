import { describe, expect, it } from "vitest";

import {
  TERMINAL_OUTPUT_TAIL_BYTES,
  appendTerminalOutputTail,
  continueTerminalReplay,
  terminalContinuityKey,
} from "../src/features/terminal/terminal-continuity";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("terminal continuity", () => {
  it("keeps Mac, Session, and runtime epoch identities separate", () => {
    expect(terminalContinuityKey("mac-a", "session", 7))
      .not.toBe(terminalContinuityKey("mac-b", "session", 7));
    expect(terminalContinuityKey("mac-a", "session", 7))
      .not.toBe(terminalContinuityKey("mac-a", "session", 8));
  });

  it("drops an identical reconnect replay instead of repainting old output", () => {
    const previous = encoder.encode("prompt\ncurrent response");
    const result = continueTerminalReplay(previous, previous);
    expect(result.continuous).toBe(true);
    expect(result.bytes).toHaveLength(0);
  });

  it("returns only output appended while the phone was detached", () => {
    const previous = encoder.encode("prompt\nworking");
    const replay = encoder.encode("prompt\nworking\ndone");
    const result = continueTerminalReplay(previous, replay);
    expect(result.continuous).toBe(true);
    expect(decoder.decode(result.bytes)).toBe("\ndone");
  });

  it("survives eviction at the front of the daemon replay ring", () => {
    const shared = "x".repeat(128);
    const previous = encoder.encode(`old-prefix${shared}`);
    const replay = encoder.encode(`${shared}new-tail`);
    const result = continueTerminalReplay(previous, replay);
    expect(result.continuous).toBe(true);
    expect(decoder.decode(result.bytes)).toBe("new-tail");
  });

  it("requires a clean rebuild when overlap is not trustworthy", () => {
    const replay = encoder.encode("current authoritative replay");
    const result = continueTerminalReplay(encoder.encode("unrelated old screen"), replay);
    expect(result.continuous).toBe(false);
    expect(result.bytes).toEqual(replay);
  });

  it("bounds retained output to the daemon replay capacity", () => {
    const previous = new Uint8Array(TERMINAL_OUTPUT_TAIL_BYTES).fill(1);
    const addition = new Uint8Array(32).fill(2);
    const result = appendTerminalOutputTail(previous, addition);
    expect(result).toHaveLength(TERMINAL_OUTPUT_TAIL_BYTES);
    expect([...result.slice(-32)]).toEqual([...addition]);
  });
});
