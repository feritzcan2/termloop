/// What a reader sees after leaving the live edge: the rows that existed when the
/// finger landed, followed by whatever the program has written since.
///
/// Content never moves under the reader. The previous design loaded history in
/// 200-row pages and corrected the viewport with an imperative scroll whenever a
/// page was prepended or the projector evicted rows above the reader. Each of those
/// corrections stopped a fling dead, so a long transcript felt stuck every 200 rows,
/// and while an agent streamed at the row cap the correction ran on every frame.
///
/// Instead, the rows present at the moment the reader left live are frozen. Rows the
/// projector has since evicted stay where they were; rows it has since created are
/// appended at the end, where they cannot shift anything above them. A frozen row
/// that still exists live shows its live content — an agent's redraw of its bottom
/// frame keeps landing in place — but at its frozen position.

/// How many rows written after the freeze are shown below it. Beyond this the live
/// edge has them, and the reader is told there is new output rather than handed an
/// unbounded list.
export const TERMINAL_READING_APPEND_LIMIT = 4800;

interface HistoryRow { readonly id: number }

export interface TerminalReadingRows<T extends HistoryRow> {
  readonly rows: readonly T[];
  readonly capped: boolean;
}

/// Rows are created in id order and only ever leave from the front, so everything
/// written since the freeze is the run of trailing live rows with ids past the last
/// frozen one. A row a program inserted above its cursor can sit out of order in the
/// middle of the live list; it is not new output and stays wherever the freeze put it.
export function terminalReadingRows<T extends HistoryRow>(
  frozen: readonly T[],
  live: readonly T[],
  limit = TERMINAL_READING_APPEND_LIMIT,
): TerminalReadingRows<T> {
  const lastId = frozen.at(-1)?.id;
  let first = live.length;
  if (lastId === undefined) first = 0;
  else while (first > 0 && live[first - 1]!.id > lastId) first -= 1;
  const appended = live.length - first;
  if (appended === 0) return { rows: frozen, capped: false };
  return {
    rows: frozen.concat(live.slice(first, first + Math.min(appended, limit))),
    capped: appended > limit,
  };
}

/// The live version of every retained row, so a frozen row can show what the
/// program has painted into it since.
export function liveTerminalRowsById<T extends HistoryRow>(live: readonly T[]): ReadonlyMap<number, T> {
  const byId = new Map<number, T>();
  for (const row of live) byId.set(row.id, row);
  return byId;
}
