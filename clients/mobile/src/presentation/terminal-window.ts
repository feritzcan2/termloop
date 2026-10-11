// Rows are fixed-height, including blank lines. Preserve the complete projection
// in memory while mounting just the viewport and an overscan on either side.
//
// The window moves in blocks rather than by the row, so a scroll event only has to
// reach React when it leaves the current block. Updating state on every native
// scroll event was what starved the JavaScript thread mid-stream and let the finger
// run ahead of the mounted rows into blank spacer.
export const TERMINAL_ROW_OVERSCAN = 32;
export const TERMINAL_WINDOW_BLOCK = 16;

export interface TerminalRowWindow {
  readonly start: number;
  readonly end: number;
  readonly before: number;
  readonly after: number;
}

export function terminalRowWindow(count: number, offset: number, height: number, lineHeight: number): TerminalRowWindow {
  const rowHeight = Math.max(1, lineHeight);
  const first = Math.floor(offset / rowHeight);
  const last = Math.ceil((offset + Math.max(height, rowHeight)) / rowHeight);
  const start = Math.max(0, Math.min(count,
    Math.floor((first - TERMINAL_ROW_OVERSCAN) / TERMINAL_WINDOW_BLOCK) * TERMINAL_WINDOW_BLOCK));
  const end = Math.min(count, Math.max(start,
    Math.ceil((last + TERMINAL_ROW_OVERSCAN) / TERMINAL_WINDOW_BLOCK) * TERMINAL_WINDOW_BLOCK));
  return { start, end, before: start * rowHeight, after: (count - end) * rowHeight };
}

export function sameTerminalRowWindow(left: TerminalRowWindow, right: TerminalRowWindow): boolean {
  return left.start === right.start && left.end === right.end;
}
