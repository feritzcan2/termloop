import type { ChangeData, HunkData, HunkTokens, TokenNode } from "react-diff-view";

/// Lines added and removed by a set of parsed hunks.
export type DiffStats = { additions: number; deletions: number };

export function diffStats(hunks: readonly HunkData[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type === "insert") additions += 1;
      else if (change.type === "delete") deletions += 1;
    }
  }
  return { additions, deletions };
}

/// A run of deletions directly followed by a run of insertions: the lines a
/// reader compares against each other.
type ReplacementRun = { deletes: ChangeData[]; inserts: ChangeData[] };

function replacementRuns(hunk: HunkData): { runs: ReplacementRun[]; order: (ChangeData | ReplacementRun)[] } {
  const runs: ReplacementRun[] = [];
  const order: (ChangeData | ReplacementRun)[] = [];
  let index = 0;
  const changes = hunk.changes;
  while (index < changes.length) {
    const change = changes[index]!;
    if (change.type !== "delete") {
      order.push(change);
      index += 1;
      continue;
    }
    const run: ReplacementRun = { deletes: [], inserts: [] };
    while (index < changes.length && changes[index]!.type === "delete") run.deletes.push(changes[index++]!);
    while (index < changes.length && changes[index]!.type === "insert") run.inserts.push(changes[index++]!);
    runs.push(run);
    order.push(run);
  }
  return { runs, order };
}

/// The changed span of a line, in UTF-16 units: [start, end).
export type EditRange = readonly [start: number, end: number];

/// The span between the common prefix and the common suffix of two lines.
/// Undefined when the lines are equal or share nothing worth marking, so a
/// rewritten line stays one colored row instead of a fully marked one.
export function lineEditRanges(before: string, after: string): { old: EditRange; new: EditRange } | undefined {
  if (before === after) return undefined;
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix
    && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) suffix += 1;
  const shared = prefix + suffix;
  if (shared === 0 || shared < Math.max(before.trim().length, after.trim().length) * 0.3) return undefined;
  return { old: [prefix, before.length - suffix], new: [prefix, after.length - suffix] };
}

/// Changed spans per side, keyed by line number, for each deleted line paired
/// with the insertion at the same position in its replacement run.
export function diffEditRanges(hunks: readonly HunkData[]): { old: Map<number, EditRange>; new: Map<number, EditRange> } {
  const ranges = { old: new Map<number, EditRange>(), new: new Map<number, EditRange>() };
  for (const hunk of hunks) {
    for (const run of replacementRuns(hunk).runs) {
      const pairs = Math.min(run.deletes.length, run.inserts.length);
      for (let index = 0; index < pairs; index += 1) {
        const removed = run.deletes[index]!;
        const added = run.inserts[index]!;
        if (removed.type !== "delete" || added.type !== "insert") continue;
        const edit = lineEditRanges(removed.content, added.content);
        if (!edit) continue;
        if (edit.old[1] > edit.old[0]) ranges.old.set(removed.lineNumber, edit.old);
        if (edit.new[1] > edit.new[0]) ranges.new.set(added.lineNumber, edit.new);
      }
    }
  }
  return ranges;
}

/// Wraps the tokens covering `range` in an `edit` node, splitting tokens at
/// its edges. Token text is never altered, only regrouped.
export function markEditRange(tokens: readonly TokenNode[], range: EditRange): TokenNode[] {
  const [start, end] = range;
  const before: TokenNode[] = [];
  const inside: TokenNode[] = [];
  const after: TokenNode[] = [];
  let offset = 0;
  for (const token of tokens) {
    const value = typeof token.value === "string" ? token.value : "";
    const tokenEnd = offset + value.length;
    const pieces: [number, number, TokenNode[]][] = [
      [offset, Math.min(tokenEnd, start), before],
      [Math.max(offset, start), Math.min(tokenEnd, end), inside],
      [Math.max(offset, end), tokenEnd, after],
    ];
    for (const [from, to, target] of pieces) {
      if (to > from) target.push({ ...token, value: value.slice(from - offset, to - offset) });
    }
    offset = tokenEnd;
  }
  return inside.length ? [...before, { type: "edit", children: inside }, ...after] : [...tokens];
}

/// Plain-text tokens for each side when no syntax colors are available, so
/// edit marks still render for plain text and while colors load.
export function plainDiffTokens(lines: { old: readonly string[]; new: readonly string[] }): HunkTokens {
  const plain = (line: string): TokenNode[] => [{ type: "text", value: line }];
  return { old: lines.old.map(plain), new: lines.new.map(plain) };
}

/// Syntax or plain tokens with each paired line's changed span marked.
export function withEditMarks(tokens: HunkTokens, hunks: readonly HunkData[]): HunkTokens {
  const ranges = diffEditRanges(hunks);
  const mark = (side: readonly TokenNode[][], edits: Map<number, EditRange>) =>
    side.map((line, index) => {
      const range = edits.get(index + 1);
      return range ? markEditRange(line, range) : line;
    });
  return { old: mark(tokens.old, ranges.old), new: mark(tokens.new, ranges.new) };
}

const collapseWhitespace = (line: string) => line.replace(/\s+/g, " ").trim();

/// The hunks with whitespace-only line replacements shown as unchanged
/// context. Only pairs aligned at the start or end of a replacement run are
/// folded, so the remaining changes keep their line order. Folded lines show
/// the new side's text. Hunks left with no change are dropped.
export function hideWhitespaceChanges(hunks: readonly HunkData[]): HunkData[] {
  const result: HunkData[] = [];
  for (const hunk of hunks) {
    const { order } = replacementRuns(hunk);
    const changes: ChangeData[] = [];
    let changed = false;
    for (const item of order) {
      if (!("deletes" in item)) {
        changes.push(item);
        continue;
      }
      const { deletes, inserts } = item;
      const same = (removed: ChangeData | undefined, added: ChangeData | undefined) =>
        removed?.type === "delete" && added?.type === "insert" && collapseWhitespace(removed.content) === collapseWhitespace(added.content);
      let head = 0;
      while (head < deletes.length && head < inserts.length && same(deletes[head], inserts[head])) head += 1;
      let tail = 0;
      while (
        tail < deletes.length - head && tail < inserts.length - head
        && same(deletes[deletes.length - 1 - tail], inserts[inserts.length - 1 - tail])
      ) tail += 1;
      const fold = (removed: ChangeData, added: ChangeData): ChangeData => ({
        type: "normal",
        isNormal: true,
        content: added.content,
        oldLineNumber: removed.type === "delete" ? removed.lineNumber : 0,
        newLineNumber: added.type === "insert" ? added.lineNumber : 0,
      });
      for (let index = 0; index < head; index += 1) changes.push(fold(deletes[index]!, inserts[index]!));
      changes.push(...deletes.slice(head, deletes.length - tail), ...inserts.slice(head, inserts.length - tail));
      for (let index = tail; index > 0; index -= 1) {
        changes.push(fold(deletes[deletes.length - index]!, inserts[inserts.length - index]!));
      }
      if (head + tail < Math.max(deletes.length, inserts.length)) changed = true;
    }
    if (changed || changes.some((change) => change.type !== "normal")) result.push({ ...hunk, changes });
  }
  return result;
}

/// The number of change blocks: runs of inserted or deleted lines between
/// unchanged ones, which is what next/previous change steps between.
export function changeBlockCount(hunks: readonly HunkData[]): number {
  let count = 0;
  for (const hunk of hunks) {
    let inBlock = false;
    for (const change of hunk.changes) {
      const changed = change.type !== "normal";
      if (changed && !inBlock) count += 1;
      inBlock = changed;
    }
  }
  return count;
}

/// The block to scroll to from the viewport's top edge, given each block's
/// top offset in ascending order; undefined when there is none that way.
export function targetChangeBlock(tops: readonly number[], viewTop: number, offset: -1 | 1): number | undefined {
  const slack = 4;
  if (offset === 1) {
    const index = tops.findIndex((top) => top > viewTop + slack);
    return index < 0 ? undefined : index;
  }
  for (let index = tops.length - 1; index >= 0; index -= 1) {
    if (tops[index]! < viewTop - slack) return index;
  }
  return undefined;
}

/// What a changed file is for, so test and generated files read apart from
/// the source a review is about.
export type ChangeFileRole = "test" | "generated";

const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|packages\.lock\.json)$|(^|\/)(generated|__generated__|dist|vendor)\/|\.(g|designer|generated)\.[A-Za-z]+$|\.min\.(js|css)$|\.snap$/i;
const TEST = /(^|\/)(tests?|__tests__|specs?|e2e)\/|(^|\/)[^/]*\.Tests?(\.[^/]+)?\/|(^|[./_-])(test|spec)s?\.[A-Za-z]+$|(^|\/)test_[^/]+$|Tests?\.[A-Za-z]+$/;

export function changeFileRole(path: string): ChangeFileRole | undefined {
  if (GENERATED.test(path)) return "generated";
  if (TEST.test(path)) return "test";
  return undefined;
}
