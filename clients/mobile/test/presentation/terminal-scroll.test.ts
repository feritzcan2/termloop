import { describe, expect, it } from "vitest";

import {
  overscrollRequest,
  reduceInitialTerminalPosition,
  scrollSequence,
  supportsTerminalWheel,
  terminalDragScroll,
} from "../../src/presentation/terminal-scroll";

const esc = String.fromCharCode(0x1b);

describe("direct terminal drag", () => {
  it("only captures drags for a program with a supported wheel protocol", () => {
    for (const tracking of ["normal", "button", "any"] as const) {
      expect(supportsTerminalWheel(tracking, true)).toBe(true);
      expect(supportsTerminalWheel(tracking, false)).toBe(false);
    }
    for (const tracking of ["unknown", "none", "x10"] as const) {
      expect(supportsTerminalWheel(tracking, true)).toBe(false);
    }
  });

  it("accumulates slow finger motion and reverses without repeating earlier input", () => {
    const first = terminalDragScroll(6, 13, 0, 0, 0);
    expect(first.lines).toBe(0);
    const second = terminalDragScroll(20, 13, first.remainder, 0, 0);
    expect(second).toEqual({ offset: 0, lines: 0, remainder: -2 });
    const third = terminalDragScroll(13, 13, second.remainder, 0, 0);
    expect(third).toEqual({ offset: 0, lines: -1, remainder: 0 });
    expect(terminalDragScroll(-39, 13, third.remainder, 0, 0)).toEqual({ offset: 0, lines: 1, remainder: 0 });
    expect(terminalDragScroll(0, 13, 0, 0, 0)).toEqual({ offset: 0, lines: 0, remainder: 0 });
  });

  it.each([15, 18, 20])("matches Codex content movement to finger distance at line height %i", (height) => {
    for (const direction of [-1, 1]) {
      for (const events of [1, 6, 60]) {
        let remainder = 0;
        let movedRows = 0;
        for (let event = 0; event < events; event += 1) {
          const motion = terminalDragScroll(direction * 30 * height / events, height, remainder, 0, 0);
          remainder = motion.remainder;
          // Codex moves three rows for each wheel report.
          movedRows += motion.lines * 3;
        }
        expect(movedRows).toBe(-direction * 30);
        expect(remainder).toBe(0);
      }
    }
  });

  it("pans a taller frame before sending either edge's remaining motion to the program", () => {
    expect(terminalDragScroll(50, 10, 0, 100, 200)).toEqual({ offset: 50, lines: 0, remainder: 0 });
    expect(terminalDragScroll(100, 10, 0, 50, 200)).toEqual({ offset: 0, lines: -1, remainder: -2 });
    expect(terminalDragScroll(-250, 10, 0, 0, 200)).toEqual({ offset: 200, lines: 1, remainder: 2 });
    // Leaving the edge clears its fractional wheel motion.
    expect(terminalDragScroll(-10, 10, -0.5, 0, 200)).toEqual({ offset: 10, lines: 0, remainder: 0 });
  });
});

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
    expect(scrollSequence(-2, "any", true)).toBe(`${esc}[<64;1;2M${esc}[<64;1;2M`);
    expect(scrollSequence(1, "any", true)).toBe(`${esc}[<65;1;2M`);
  });

  it("accepts the other wheel-capable tracking modes", () => {
    expect(scrollSequence(-1, "normal", true)).toBe(`${esc}[<64;1;2M`);
    expect(scrollSequence(-1, "button", true)).toBe(`${esc}[<64;1;2M`);
  });

  it("never sends a wheel report to a program that has not asked for one", () => {
    /// A late attach has never seen the enable sequence. Guessing wrong types
    /// `ESC[<64;1;2M` into a shell prompt, or runs it as commands in vim.
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
