import { expect, it } from "vitest";

import { pinchDistance, pinchStep, PINCH_STEP_RATIO } from "../../src/presentation/terminal-pinch";
import { selectedRowRange, selectedText } from "../../src/presentation/terminal-selection";

const rows = [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }];

it("orders a selection made upwards or downwards", () => {
  expect(selectedRowRange(rows, { anchorId: 11, endId: 13 })).toEqual({ start: 1, end: 3 });
  expect(selectedRowRange(rows, { anchorId: 13, endId: 10 })).toEqual({ start: 0, end: 3 });
});

it("ends a selection whose rows left the window", () => {
  expect(selectedRowRange(rows, { anchorId: 9, endId: 12 })).toBeUndefined();
});

it("copies rows without cell padding or the blank rows framing them", () => {
  expect(selectedText(["", "$ pnpm test   ", "  ok  ", "   "])).toBe("$ pnpm test\n  ok");
  expect(selectedText(["   "])).toBe("");
});

it("steps text size once per pinch threshold", () => {
  expect(pinchDistance([{ pageX: 0, pageY: 0 }, { pageX: 3, pageY: 4 }])).toBe(5);
  expect(pinchDistance([{ pageX: 0, pageY: 0 }])).toBeUndefined();
  expect(pinchStep(100, 100 * PINCH_STEP_RATIO)).toBe(1);
  expect(pinchStep(100, 100 / PINCH_STEP_RATIO)).toBe(-1);
  expect(pinchStep(100, 105)).toBe(0);
  expect(pinchStep(0, 50)).toBe(0);
});
