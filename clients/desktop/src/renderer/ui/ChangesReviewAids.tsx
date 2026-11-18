import type { DiffStats } from "../diff-review.js";
import { Icon } from "./Icon.js";

/// Keyboard shortcuts, the change summary and next-file choice that speed up
/// reviewing a set of changed files.
export type ReviewKeyAction = "nextFile" | "previousFile" | "nextChange" | "previousChange" | "reviewed" | "whitespace" | "shortcuts";

export const REVIEW_KEYS: Readonly<Record<string, ReviewKeyAction>> = {
  j: "nextFile",
  k: "previousFile",
  n: "nextChange",
  p: "previousChange",
  r: "reviewed",
  w: "whitespace",
  "?": "shortcuts",
};

const REVIEW_SHORTCUTS: readonly [keys: string, action: string][] = [
  ["J / ↓", "Next file"],
  ["K / ↑", "Previous file"],
  ["N", "Next change"],
  ["P", "Previous change"],
  ["R", "Mark file reviewed and open the next"],
  ["W", "Hide whitespace changes"],
  ["?", "Show or hide these shortcuts"],
  ["Esc", "Close changes"],
];

export function ReviewShortcuts({ close }: { close(): void }) {
  return (
    <div className="changes-shortcuts" role="dialog" aria-label="Keyboard shortcuts">
      <dl>
        {REVIEW_SHORTCUTS.map(([keys, action]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>)}
      </dl>
      <button type="button" className="icon-button quiet" aria-label="Close shortcuts" onClick={close}><Icon name="close" /></button>
    </div>
  );
}

/// "+31 −24 · change 2/7" for the shown diff.
export function DiffSummary({ stats, current, count }: { stats: DiffStats | undefined; current: number | undefined; count: number }) {
  return <span className="changes-diff-summary">
    {stats ? <><b className="additions">+{stats.additions}</b><b className="deletions">−{stats.deletions}</b></> : null}
    <span>{count === 0 ? "no changes" : current === undefined ? `${count} ${count === 1 ? "change" : "changes"}` : `change ${current}/${count}`}</span>
  </span>;
}

/// The entry to open after `entryId` is marked reviewed: the next one still
/// to review below it, else the nearest one above it.
export function nextPendingEntry(
  visible: readonly { entry_id: string }[],
  entryId: string,
  reviewed: ReadonlySet<string>,
): string | undefined {
  const index = visible.findIndex((entry) => entry.entry_id === entryId);
  const pending = (entry: { entry_id: string }) => entry.entry_id !== entryId && !reviewed.has(entry.entry_id);
  return visible.slice(index + 1).find(pending)?.entry_id
    ?? visible.slice(0, Math.max(index, 0)).reverse().find(pending)?.entry_id;
}
