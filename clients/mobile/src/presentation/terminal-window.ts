// Rows are fixed-height, including blank lines. Preserve the complete projection
// in memory while mounting just the viewport and a small selection overscan.
export function terminalRowWindow(count: number, offset: number, height: number, lineHeight: number) {
  const rowHeight = Math.max(1, lineHeight);
  const start = Math.max(0, Math.min(count, Math.floor(offset / rowHeight) - 24));
  const end = Math.min(count, Math.max(start, Math.ceil((offset + Math.max(height, rowHeight)) / rowHeight) + 24));
  return { start, end, before: start * rowHeight, after: (count - end) * rowHeight };
}
