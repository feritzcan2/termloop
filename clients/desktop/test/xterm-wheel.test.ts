import { describe, expect, it } from "vitest";
import { sgrWheelReports, wheelToArrowLines } from "../src/renderer/terminal/xterm/wheel.js";

describe("alternate-screen wheel conversion", () => {
  it("converts a full mouse notch to its pixel-proportional line count", () => {
    const { lines, remainder } = wheelToArrowLines(-120, 0, 16, 0);
    expect(lines).toBe(-7);
    expect(remainder).toBeCloseTo(-0.5);
  });

  it("accumulates trackpad deltas below one cell instead of dropping them", () => {
    let remainder = 0;
    let total = 0;
    for (let event = 0; event < 10; event += 1) {
      const step = wheelToArrowLines(-8, 0, 16, remainder);
      remainder = step.remainder;
      total += step.lines;
    }
    expect(total).toBe(-5);
  });

  it("keeps the remainder direction-consistent when the gesture reverses", () => {
    const up = wheelToArrowLines(-10, 0, 16, 0);
    expect(up.lines).toBe(0);
    const down = wheelToArrowLines(10, 0, 16, up.remainder);
    expect(down.lines).toBe(0);
    expect(down.remainder).toBeCloseTo(0);
  });

  it("passes line-mode deltas through without cell scaling", () => {
    expect(wheelToArrowLines(-3, 1, 16, 0)).toEqual({ lines: -3, remainder: 0 });
  });

  it("never divides by a degenerate cell height", () => {
    const { lines } = wheelToArrowLines(-32, 0, 0, 0);
    expect(lines).toBe(-32);
  });
});

describe("SGR wheel reports", () => {
  it("emits one positioned report per line with the wheel direction code", () => {
    expect(sgrWheelReports(-2, 10, 5)).toBe("[<64;10;5M[<64;10;5M");
    expect(sgrWheelReports(1, 3, 7)).toBe("[<65;3;7M");
  });

  it("clamps degenerate coordinates to the first cell", () => {
    expect(sgrWheelReports(1, 0, -4)).toBe("[<65;1;1M");
  });
});
