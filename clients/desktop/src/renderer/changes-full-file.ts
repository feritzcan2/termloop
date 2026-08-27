// Full-file mode for the changes viewer.
//
// The bounded patch only carries the lines inside its hunks. Given the old-side
// (pre-image) file text from `task.worktreePreImage`, these helpers expand the
// parsed patch so it covers the whole file, or refuse with an explicit reason.
//
// The reconstruction is exact, line for line: see
// `clients/desktop/test/changes-full-file.test.ts` and the daemon-level
// acceptance run in `tests/e2e/f2/full-file-view.mjs`.
import {
  computeOldLineNumber,
  expandFromRawCode,
  getCollapsedLinesCountBetween,
  type HunkData,
} from "react-diff-view";
import type { TaskWorktreePreImageState } from "@termloop/contract/current";

/**
 * The bounds the contract already applies to one patch DTO. A full-file mode
 * must not widen them.
 */
export const FULL_FILE_MAX_LINES = 20_000;
export const FULL_FILE_MAX_BYTES = 262_144;

const encoder = new TextEncoder();

export type SourceMismatch = {
  oldLineNumber: number;
  patchLine: string;
  sourceLine: string | undefined;
};

export type FullFileView =
  /** Every old-side line is now covered by the returned hunks. */
  | { state: "fullFile"; hunks: HunkData[]; revealedLines: number; totalLines: number }
  /** The patch already covered the whole file; the toggle has nothing to add. */
  | { state: "alreadyComplete"; hunks: HunkData[]; totalLines: number }
  /** Larger than the accepted bounds. */
  | { state: "tooLarge"; lines: number; bytes: number }
  /** The source disagrees with the patch's own context, so it is not the pre-image. */
  | { state: "stale"; mismatch: SourceMismatch }
  /** Structurally impossible to place in file context. */
  | { state: "unavailable"; reason: string };

/**
 * Split a file the way `expandFromRawCode` indexes it: line N sits at position
 * N-1. A single trailing newline terminates the last line rather than adding an
 * empty one, otherwise every expansion appends a phantom line.
 */
export function sourceLines(source: string): string[] {
  const lines = source.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Old-side lines the patch does not show: before, between, and after its hunks. */
export function collapsedLineCount(hunks: readonly HunkData[], totalLines: number): number {
  const last = hunks[hunks.length - 1];
  if (!last) return totalLines;
  const between = hunks.reduce(
    (collapsed, hunk, index) => collapsed + gapBefore(hunks, index, hunk),
    0,
  );
  return between + Math.max(totalLines - (last.oldStart + last.oldLines - 1), 0);
}

/**
 * Old-side lines hidden immediately before `hunk`. Exported so the gap markers
 * beside the diff and the total below it are the same number.
 */
export function gapBefore(hunks: readonly HunkData[], index: number, hunk: HunkData): number {
  return getCollapsedLinesCountBetween(hunks[index - 1] ?? null, hunk);
}

/**
 * Every context and deleted line in the patch is a line of the old file, so it
 * must match the supplied source at the same line number. A mismatch means the
 * source is not this patch's pre-image, and expanding it would show the user
 * file content that never existed.
 *
 * This only covers lines the patch carries. Drift inside the collapsed region is
 * not detectable here; freshness of that content comes from the daemon's
 * observation generation, which refuses a stale request before we ever see it.
 */
export function findSourceMismatch(
  hunks: readonly HunkData[],
  lines: readonly string[],
): SourceMismatch | undefined {
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      const line = computeOldLineNumber(change);
      if (line < 1) continue;
      const sourceLine = lines[line - 1];
      if (sourceLine !== change.content) {
        return { oldLineNumber: line, patchLine: change.content, sourceLine };
      }
    }
  }
  return undefined;
}

/** Expand a bounded patch to cover the entire old-side file. */
export function fullFileView(hunks: readonly HunkData[], source: string): FullFileView {
  if (hunks.length === 0) {
    return { state: "unavailable", reason: "This patch has no hunks to place in file context." };
  }
  const lines = sourceLines(source);
  // UTF-8 length is never below the UTF-16 code-unit count, so the cheap test
  // rules out the byte bound without transcoding the whole file.
  if (lines.length > FULL_FILE_MAX_LINES || source.length > FULL_FILE_MAX_BYTES) {
    const bytes = encoder.encode(source).byteLength;
    if (lines.length > FULL_FILE_MAX_LINES || bytes > FULL_FILE_MAX_BYTES) {
      return { state: "tooLarge", lines: lines.length, bytes };
    }
  }
  const mismatch = findSourceMismatch(hunks, lines);
  if (mismatch) return { state: "stale", mismatch };
  const collapsed = collapsedLineCount(hunks, lines.length);
  if (collapsed <= 0) {
    return { state: "alreadyComplete", hunks: [...hunks], totalLines: lines.length };
  }
  // `end` is exclusive, so cover the last line by asking for one past it.
  const expanded = expandFromRawCode([...hunks], lines, 1, lines.length + 1);
  return { state: "fullFile", hunks: expanded, revealedLines: collapsed, totalLines: lines.length };
}

/**
 * Why a pre-image result cannot be expanded, phrased for the user. `content` is
 * the only state that yields source text, so it returns undefined there.
 *
 * Exhaustive over the generated state union on purpose: adding a state to the
 * schema must fail the type check here rather than silently fall back to a
 * generic message.
 */
export function preImageRefusal(state: TaskWorktreePreImageState): string | undefined {
  switch (state) {
    case "content":
      return undefined;
    case "absent":
      return "This file is newly added, so the patch already shows all of it.";
    case "binary":
      return "Binary content is not shown in this viewer.";
    case "notShown":
      return "This content is outside the read-only viewer.";
    case "truncated":
      return `The file exceeds the ${FULL_FILE_MAX_BYTES.toLocaleString()}-byte safety limit.`;
    case "nonUtf8":
      return "The file cannot be shown without corrupting its bytes.";
  }
}

/**
 * One sentence for every full-file outcome. Refusals always say the
 * change-focused diff is still on screen, so a refused expansion never reads as
 * a broken view.
 */
export function fullFileStatusMessage({ fullFile, unsupportedReason, loading, error, view }: {
  fullFile: boolean;
  unsupportedReason: string | undefined;
  loading: boolean;
  error: string | undefined;
  view: FullFileView | undefined;
}): string | undefined {
  if (!fullFile) return undefined;
  if (unsupportedReason) return `${unsupportedReason} Showing the change-focused diff.`;
  if (loading) return "Loading the full file\u2026";
  if (error) return `${error} The change-focused diff is still shown.`;
  if (!view) return undefined;
  switch (view.state) {
    case "fullFile":
      return `Showing all ${view.totalLines.toLocaleString()} lines; ${view.revealedLines.toLocaleString()} were not in the patch.`;
    case "alreadyComplete":
      return "This patch already covers the whole file.";
    case "tooLarge":
      return `Full file not shown: ${view.lines.toLocaleString()} lines / ${view.bytes.toLocaleString()} bytes exceeds the ${FULL_FILE_MAX_LINES.toLocaleString()}-line, ${FULL_FILE_MAX_BYTES.toLocaleString()}-byte limit. The change-focused diff is still shown.`;
    case "stale":
      return `Full file not shown: the file changed since this patch was produced (line ${view.mismatch.oldLineNumber} no longer matches). Refresh and try again.`;
    case "unavailable":
      return `Full file not shown: ${view.reason} The change-focused diff is still shown.`;
  }
}
