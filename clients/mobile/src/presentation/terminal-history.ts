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
): TerminalHistoryPage {
  if (current.rows === rows && current.kind === kind) return current;
  if (followingLive || current.kind !== kind || current.rows.length === 0) {
    return recentTerminalHistory(rows, kind);
  }
  const positions = new Map(rows.map((row, index) => [row.id, index]));
  for (let index = current.start; index < current.rows.length; index += 1) {
    const position = positions.get(current.rows[index]!.id);
    if (position !== undefined) return { rows, kind, start: position };
  }
  return recentTerminalHistory(rows, kind);
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
  const row = page.rows[Math.min(page.rows.length - 1, page.start + Math.floor(position))];
  return row === undefined ? undefined : { id: row.id, fraction: position % 1 };
}

export function terminalReadingOffset(
  page: TerminalHistoryPage,
  anchor: TerminalReadingAnchor,
  lineHeight: number,
): number {
  const index = page.rows.findIndex((row) => row.id === anchor.id);
  return index < page.start ? 0 : (index - page.start + anchor.fraction) * Math.max(1, lineHeight);
}
