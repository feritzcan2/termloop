import { describe, expect, it } from "vitest";

import {
  earlierTerminalHistory, recentTerminalHistory, reconcileTerminalHistory,
  terminalReadingAnchor, terminalReadingOffset, terminalRowIndex,
} from "../../src/presentation/terminal-history";
import { terminalRowWindow } from "../../src/presentation/terminal-window";

const rows = (count: number, first = 1) => Array.from({ length: count }, (_, i) => ({ id: first + i }));

describe("incremental terminal history", () => {
  it("starts with the newest 200 rows and reveals earlier pages without skips or duplicates", () => {
    const source = rows(510);
    let page = recentTerminalHistory(source, "screen");
    expect(source.slice(page.start).map((row) => row.id)).toEqual(rows(200, 311).map((row) => row.id));
    page = earlierTerminalHistory(page);
    expect(page.start).toBe(110);
    page = earlierTerminalHistory(page);
    expect(page.start).toBe(0);
    expect(page.rows).toBe(source);
    expect(earlierTerminalHistory(page)).toBe(page);
  });

  it("preserves the same reading line and partial-line position after a prepend", () => {
    const page = recentTerminalHistory(rows(4800), "screen");
    const anchor = terminalReadingAnchor(page, 42, 16)!;
    const earlier = earlierTerminalHistory(page);
    const offset = terminalReadingOffset(earlier, anchor, 16);
    expect(offset).toBe(3242);
    expect(terminalReadingAnchor(earlier, offset, 16)).toEqual(anchor);
    const window = terminalRowWindow(earlier.rows.length - earlier.start, offset, 600, 16);
    expect(window.end - window.start).toBeLessThan(160);
  });

  it("does not shift the reader when live output evicts only unseen cached rows", () => {
    const page = recentTerminalHistory(rows(600), "stream");
    const anchor = terminalReadingAnchor(page, 48, 16)!;
    const next = reconcileTerminalHistory(page, rows(600, 21), "stream", false);
    expect(next.start).toBe(380);
    expect(terminalReadingOffset(next, anchor, 16)).toBe(48);
  });

  it("adjusts for eviction of loaded rows and honestly clamps an expired reading anchor", () => {
    const page = earlierTerminalHistory(earlierTerminalHistory(recentTerminalHistory(rows(600), "stream")));
    const anchor = terminalReadingAnchor(page, 400, 16)!;
    const next = reconcileTerminalHistory(page, rows(600, 21), "stream", false);
    expect(next.start).toBe(0);
    expect(terminalReadingOffset(next, anchor, 16)).toBe(80);
    expect(terminalReadingOffset(next, terminalReadingAnchor(page, 16, 16)!, 16)).toBe(0);
  });

  it("follows live output with a bounded recent page and starts replaced renderers at the live edge", () => {
    const page = earlierTerminalHistory(recentTerminalHistory(rows(4800), "screen"));
    expect(reconcileTerminalHistory(page, rows(4800, 21), "screen", true).start).toBe(4600);
    expect(reconcileTerminalHistory(page, rows(500), "stream", false).start).toBe(300);
    expect(reconcileTerminalHistory(page, rows(500, 10000), "screen", false).start).toBe(300);
  });

  it("handles empty and short output and preserves reading position across font changes", () => {
    const empty = recentTerminalHistory([], "stream");
    expect(empty.start).toBe(0);
    expect(terminalReadingAnchor(empty, 0, 16)).toBeUndefined();
    const short = reconcileTerminalHistory(empty, rows(3), "stream", false);
    expect(short.start).toBe(0);
    const anchor = terminalReadingAnchor(short, 24, 16)!;
    expect(terminalReadingOffset(short, anchor, 20)).toBe(30);
  });

  it.each([24, 510])("keeps all %i rows visible while the program scrolls its own frame", (count) => {
    const source = rows(count);
    const page = { rows: source, kind: "screen" as const, start: 0 };
    const repainted = [...rows(3, 10000), ...source.slice(0, -3)];
    const next = reconcileTerminalHistory(page, repainted, "screen", false, true);
    expect(next.start).toBe(0);
    expect(next.rows).toBe(repainted);
    // Local history still preserves a reading anchor across prepends.
    expect(reconcileTerminalHistory(page, repainted, "screen", false).start).toBe(3);
  });

  it("finds a row from its last index without scanning, and still finds a reordered row", () => {
    const source = rows(4800);
    expect(terminalRowIndex(source, 4000, 3999)).toBe(3999);
    // Front eviction moved it a few places back.
    expect(terminalRowIndex(source.slice(5), 4000, 3999)).toBe(3994);
    // A prepend moved it forward.
    expect(terminalRowIndex([...rows(3, 9001), ...source], 4000, 3999)).toBe(4002);
    expect(terminalRowIndex(source, 99999, 3999)).toBeUndefined();
    // A row inserted above the cursor can sit out of id order; it is still found.
    const reordered = [{ id: 1 }, { id: 50 }, { id: 2 }, { id: 3 }];
    expect(terminalRowIndex(reordered, 50, 3)).toBe(1);
    expect(terminalRowIndex(reordered, 2, 0)).toBe(2);
  });

  it("moves the mounted window in blocks so most scroll events change nothing", () => {
    const a = terminalRowWindow(4800, 10000, 600, 16);
    const b = terminalRowWindow(4800, 10000 + 5 * 16, 600, 16);
    expect(b).toEqual(a);
    const c = terminalRowWindow(4800, 10000 + 40 * 16, 600, 16);
    expect(c.start).toBeGreaterThan(a.start);
    expect(c.start % 16).toBe(0);
  });
});
