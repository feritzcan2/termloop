import { describe, expect, it } from "vitest";

import {
  overscrollRequest,
  reduceInitialTerminalPosition,
  scrollSequence,
} from "../../src/presentation/terminal-scroll";

const esc = String.fromCharCode(0x1b);

describe("initial terminal position", () => {
  it("waits for real output instead of revealing the empty top of the scroll view", () => {
    expect(reduceInitialTerminalPosition("waitingForContent", {
      type: "contentChanged",
      hasContent: false,
    })).toBe("waitingForContent");
    expect(reduceInitialTerminalPosition("waitingForContent", { type: "positioned" }))
      .toBe("waitingForContent");
  });

  it("reveals the first output only after its bottom placement finishes", () => {
    const positioning = reduceInitialTerminalPosition("waitingForContent", {
      type: "contentChanged",
      hasContent: true,
    });
    expect(positioning).toBe("positioning");
    expect(reduceInitialTerminalPosition(positioning, { type: "positioned" })).toBe("ready");
  });

  it("stays visible while later live output changes the content size", () => {
    expect(reduceInitialTerminalPosition("ready", {
      type: "contentChanged",
      hasContent: true,
    })).toBe("ready");
  });
});

/// The alternate screen has no scrollback: the program owns the grid and repaints it,
/// so the only way past the current frame is to ask the program to scroll itself. That
/// is input, and input that lands in a program which is not listening for it does
/// damage — hence the care about which sequence goes out when.
describe("scroll-back sequence", () => {
  it("turns either edge's overscroll into the matching program direction", () => {
    expect(overscrollRequest(-39, 480, 240, 13)).toBe(-3);
    expect(overscrollRequest(279, 480, 240, 13)).toBe(3);
  });

  it("does not send a program scroll while local screen rows remain", () => {
    expect(overscrollRequest(120, 480, 240, 13)).toBe(0);
    expect(overscrollRequest(240, 480, 240, 13)).toBe(0);
  });

  it("works when the projected frame is shorter than the phone viewport", () => {
    expect(overscrollRequest(-26, 120, 240, 13)).toBe(-2);
    expect(overscrollRequest(26, 120, 240, 13)).toBe(2);
  });

  it("sends SGR wheel reports once a program has said it tracks the mouse", () => {
    expect(scrollSequence(-2, "any", true)).toBe(`${esc}[<64;1;1M${esc}[<64;1;1M`);
    expect(scrollSequence(1, "any", true)).toBe(`${esc}[<65;1;1M`);
  });

  it("accepts the other wheel-capable tracking modes", () => {
    expect(scrollSequence(-1, "normal", true)).toBe(`${esc}[<64;1;1M`);
    expect(scrollSequence(-1, "button", true)).toBe(`${esc}[<64;1;1M`);
  });

  it("never sends a wheel report to a program that has not asked for one", () => {
    /// A late attach has never seen the enable sequence. Guessing wrong types
    /// `ESC[<64;1;1M` into a shell prompt, or runs it as commands in vim.
    const unknown = scrollSequence(-3, "unknown", false);
    expect(unknown).not.toContain("<64");
    expect(unknown).toBe(`${esc}[5~`);
    expect(scrollSequence(-3, "none", false)).toBe(`${esc}[5~`);
  });

  it("falls back for press-only X10 tracking, which has no wheel vocabulary", () => {
    expect(scrollSequence(-3, "x10", true)).toBe(`${esc}[5~`);
  });

  it("falls back when tracking is on but the SGR encoding was never seen", () => {
    expect(scrollSequence(-3, "any", false)).toBe(`${esc}[5~`);
  });

  it("never falls back to arrow keys, which walk Claude's input history", () => {
    for (const tracking of ["unknown", "none", "x10", "any"] as const) {
      const sequence = scrollSequence(-4, tracking, false);
      expect(sequence).not.toContain(`${esc}[A`);
      expect(sequence).not.toContain(`${esc}[B`);
      expect(sequence).not.toContain(`${esc}OA`);
    }
  });

  it("paces the page fallback rather than flinging through the whole history", () => {
    expect(scrollSequence(-3, "unknown", false)).toBe(`${esc}[5~`);
    expect(scrollSequence(-9, "unknown", false)).toBe(`${esc}[5~`.repeat(3));
    /// Forward is the other page key.
    expect(scrollSequence(3, "unknown", false)).toBe(`${esc}[6~`);
  });

  it("always moves at least one page when asked to move at all", () => {
    expect(scrollSequence(-1, "unknown", false)).toBe(`${esc}[5~`);
  });
});
