export const TERMINAL_HISTORY_PAGE_ROWS = 200;

interface HistoryRow { readonly id: number }
type HistoryKind = "screen" | "stream";

export interface TerminalHistoryPage {
  readonly rows: readonly HistoryRow[];
  readonly kind: HistoryKind;
  readonly start: number;
}

export interface TerminalReadingAnchor {
  readonly id: number;
  readonly fraction: number;
  /// Where the row sat when the anchor was taken; a hint for finding it again.
  readonly index?: number;
}

export function recentTerminalHistory(rows: readonly HistoryRow[], kind: HistoryKind): TerminalHistoryPage {
  return { rows, kind, start: Math.max(0, rows.length - TERMINAL_HISTORY_PAGE_ROWS) };
}

// Keep the same first loaded row while reading. Evicting an unseen cached prefix
// must not move the viewport; a replaced projection starts from its recent end.
export function reconcileTerminalHistory(
  current: TerminalHistoryPage,
  rows: readonly HistoryRow[],
  kind: HistoryKind,
  followingLive: boolean,
  programReading = false,
): TerminalHistoryPage {
  if (current.rows === rows && current.kind === kind) return current;
  // Once a drag reaches the program, show its entire repainted frame. Row
  // identities move during terminal scrolling; they are not reading anchors.
  if (programReading && kind === "screen") return { rows, kind, start: 0 };
  if (followingLive || current.kind !== kind || current.rows.length === 0) {
    return recentTerminalHistory(rows, kind);
  }
  for (let index = current.start; index < current.rows.length; index += 1) {
    const position = terminalRowIndex(rows, current.rows[index]!.id, index);
    if (position !== undefined) return { rows, kind, start: position };
  }
  return recentTerminalHistory(rows, kind);
}

/// Locates a row by id, starting from where it was last seen.
///
/// Rows are only ever appended or evicted from the front, so between two frames a row
/// sits at its previous index or a little before it. Checking there first keeps the
/// per-frame cost of reading during a stream constant instead of walking every
/// retained row to build a lookup table sixty times a second.
export function terminalRowIndex(rows: readonly HistoryRow[], id: number, hint: number): number | undefined {
  const from = Math.max(0, Math.min(rows.length - 1, hint));
  for (let index = from; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.id === id) return index;
    if (row.id < id) break;
  }
  for (let index = from + 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.id === id) return index;
    if (row.id > id) break;
  }
  /// Ids are usually monotonic, but a program that inserts rows above its cursor can
  /// push a newer row into history ahead of an older one. Finish with a full scan
  /// before concluding the row is gone.
  const index = rows.findIndex((row) => row.id === id);
  return index < 0 ? undefined : index;
}

export function earlierTerminalHistory(current: TerminalHistoryPage): TerminalHistoryPage {
  return current.start === 0 ? current
    : { ...current, start: Math.max(0, current.start - TERMINAL_HISTORY_PAGE_ROWS) };
}

export function terminalReadingAnchor(
  page: TerminalHistoryPage,
  offset: number,
  lineHeight: number,
): TerminalReadingAnchor | undefined {
  const position = Math.max(0, offset) / Math.max(1, lineHeight);
  const index = Math.min(page.rows.length - 1, page.start + Math.floor(position));
  const row = page.rows[index];
  return row === undefined ? undefined : { id: row.id, fraction: position % 1, index };
}

export function terminalReadingOffset(
  page: TerminalHistoryPage,
  anchor: TerminalReadingAnchor,
  lineHeight: number,
): number {
  const index = terminalRowIndex(page.rows, anchor.id, anchor.index ?? page.start) ?? -1;
  return index < page.start ? 0 : (index - page.start + anchor.fraction) * Math.max(1, lineHeight);
}
