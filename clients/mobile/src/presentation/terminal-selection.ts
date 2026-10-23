/// A range of displayed rows chosen for copying, by row identity rather than by
/// position: rows keep arriving while the user selects, and an index would slide.
export interface TerminalSelection {
  readonly anchorId: number;
  readonly endId: number;
}

export interface SelectableRow {
  readonly id: number;
}

export function selectedRowRange(
  rows: readonly SelectableRow[],
  selection: TerminalSelection,
): { start: number; end: number } | undefined {
  const anchor = rows.findIndex((row) => row.id === selection.anchorId);
  const end = rows.findIndex((row) => row.id === selection.endId);
  if (anchor === -1 || end === -1) return undefined;
  return { start: Math.min(anchor, end), end: Math.max(anchor, end) };
}

/// The copied text: each row without its trailing cell padding, and without the
/// blank rows a TUI frame leaves at either end of a selection.
export function selectedText(rowTexts: readonly string[]): string {
  const lines = rowTexts.map((text) => text.trimEnd());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.length === 0) start += 1;
  while (end > start && lines[end - 1]!.length === 0) end -= 1;
  return lines.slice(start, end).join("\n");
}
