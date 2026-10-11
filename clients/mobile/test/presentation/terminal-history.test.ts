import { describe, expect, it } from "vitest";

import {
  liveTerminalRowsById, terminalReadingRows,
} from "../../src/presentation/terminal-history";
import { terminalRowWindow } from "../../src/presentation/terminal-window";

const rows = (count: number, first = 1) => Array.from({ length: count }, (_, i) => ({ id: first + i }));

describe("frozen reading rows", () => {
  it("keeps the frozen rows in place and appends only rows written since", () => {
    const frozen = rows(300);
    // The projector evicted 20 rows from the front and wrote 5 new ones.
    const live = rows(285, 21);
    const reading = terminalReadingRows(frozen, live);
    expect(reading.rows.slice(0, 300)).toEqual(frozen);
    expect(reading.rows.slice(300).map((row) => row.id)).toEqual([301, 302, 303, 304, 305]);
    expect(reading.capped).toBe(false);
  });

  it("returns the frozen array itself while nothing new arrived", () => {
    const frozen = rows(10);
    expect(terminalReadingRows(frozen, rows(8, 3)).rows).toBe(frozen);
    expect(terminalReadingRows([], rows(3)).rows.map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it("does not treat a row inserted above the cursor as new output", () => {
    const frozen = rows(5);
    const live = [{ id: 1 }, { id: 9 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
    expect(terminalReadingRows(frozen, live).rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("caps appended output and says so", () => {
    const reading = terminalReadingRows(rows(2), rows(12, 3), 4);
    expect(reading.rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(reading.capped).toBe(true);
  });

  it("maps a frozen row to its live content", () => {
    const live = [{ id: 1, text: "old" }, { id: 2, text: "painted" }];
    const byId = liveTerminalRowsById(live);
    expect(byId.get(2)?.text).toBe("painted");
    expect(byId.get(7)).toBeUndefined();
  });
});

describe("terminal row window", () => {
  it("mounts a bounded window and preserves total height", () => {
    const window = terminalRowWindow(4800, 10000, 600, 16);
    expect(window.end - window.start).toBeLessThan(160);
    expect(window.before + (window.end - window.start) * 16 + window.after).toBe(4800 * 16);
  });

  it("moves the mounted window in blocks so most scroll events change nothing", () => {
    const a = terminalRowWindow(4800, 10000, 600, 16);
    const b = terminalRowWindow(4800, 10000 + 5 * 16, 600, 16);
    expect(b).toEqual(a);
    const c = terminalRowWindow(4800, 10000 + 40 * 16, 600, 16);
    expect(c.start).toBeGreaterThan(a.start);
    expect(c.start % 16).toBe(0);
  });

  it("handles empty and short output", () => {
    expect(terminalRowWindow(0, 0, 600, 16)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
    expect(terminalRowWindow(5, 0, 600, 16)).toEqual({ start: 0, end: 5, before: 0, after: 0 });
  });
});
