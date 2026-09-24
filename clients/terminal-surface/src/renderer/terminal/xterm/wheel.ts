// Pixel-proportional wheel-to-arrow-line conversion for alternate-screen TUIs.
// xterm's own alt-buffer fallback quantises a wheel event to roughly one line
// per ~120px and drops sub-line deltas outright, so trackpad scrolling in a
// full-screen TUI (Claude Code) crawls or does nothing. Accumulating the
// fractional remainder across events restores native-terminal scroll feel.
// SGR (1006) wheel report for TUIs that track the mouse, one report per line.
// Claude Code and other modern full-screen TUIs enable SGR encoding alongside
// their tracking mode; legacy X10 tracking never reaches this path.
export function sgrWheelReports(lines: number, column: number, row: number): string {
  const code = lines < 0 ? 64 : 65;
  return `[<${code};${Math.max(1, column)};${Math.max(1, row)}M`.repeat(Math.abs(lines));
}

export function wheelToArrowLines(
  deltaY: number,
  deltaMode: number,
  cellHeightPx: number,
  remainder: number,
): { lines: number; remainder: number } {
  // WheelEvent.DOM_DELTA_LINE (1) and DOM_DELTA_PAGE (2) already carry line
  // counts; pixels (0) divide by the cell height.
  const deltaLines = deltaMode === 0 ? deltaY / Math.max(1, cellHeightPx) : deltaY;
  const total = remainder + deltaLines;
  const lines = Math.trunc(total) || 0;
  return { lines, remainder: total - lines };
}
