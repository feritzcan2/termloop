/// Reconstructs the current full file from a bounded pre-image and the exact
/// diff observation. The phone never reads a worktree path: Core supplied both
/// inputs under the same observation id, and a mismatch refuses the expansion.

export type ParsedDiffChange = {
  content?: string | undefined;
  type: "normal" | "insert" | "delete";
};

export type ParsedDiffHunk = {
  oldStart: number;
  changes: readonly ParsedDiffChange[];
};

export type ParsedDiffFile = {
  hunks: readonly ParsedDiffHunk[];
};

export type FullFileDisplayLine =
  | { type: "code"; content: string; changed: boolean }
  | { type: "deleted"; count: number };

export type FullFileReconstruction =
  | {
    state: "content";
    content: string;
    lineCount: number;
    changedLineCount: number;
    displayLines: readonly FullFileDisplayLine[];
  }
  | { state: "unavailable"; reason: string };

/// Applies a unified patch to Core's old-side file content. Normal and deleted
/// lines must agree with the pre-image at the exact hunk position. That check is
/// what prevents a fresh-looking full-file view from being constructed against a
/// stale or unrelated source blob.
export function reconstructFullFile(
  files: readonly ParsedDiffFile[],
  source: string,
): FullFileReconstruction {
  if (files.length !== 1) {
    return { state: "unavailable", reason: "This patch does not describe one text file." };
  }
  const file = files[0];
  if (file === undefined || file.hunks.length === 0) {
    return { state: "unavailable", reason: "This patch has no text hunks to expand." };
  }
  const oldLines = sourceLines(source);
  const output: string[] = [];
  const displayLines: FullFileDisplayLine[] = [];
  let sourceIndex = 0;
  let pendingDeletedLines = 0;
  let changedLineCount = 0;
  const appendCode = (content: string, changed: boolean) => {
    if (pendingDeletedLines > 0) {
      displayLines.push({ type: "deleted", count: pendingDeletedLines });
      pendingDeletedLines = 0;
    }
    output.push(content);
    displayLines.push({ type: "code", content, changed });
    if (changed) changedLineCount += 1;
  };

  for (const hunk of file.hunks) {
    const hunkStart = Math.max(hunk.oldStart - 1, 0);
    if (hunkStart < sourceIndex || hunkStart > oldLines.length) {
      return { state: "unavailable", reason: "The patch hunk positions do not match this file." };
    }
    oldLines.slice(sourceIndex, hunkStart).forEach((line) => appendCode(line, false));
    sourceIndex = hunkStart;

    for (const change of hunk.changes) {
      const content = change.content ?? "";
      if (change.type === "insert") {
        appendCode(content, true);
        continue;
      }
      const sourceLine = oldLines[sourceIndex];
      if (sourceLine !== content) {
        return { state: "unavailable", reason: `The file changed near line ${sourceIndex + 1}. Refresh and try again.` };
      }
      sourceIndex += 1;
      if (change.type === "normal") appendCode(content, false);
      else pendingDeletedLines += 1;
    }
  }

  oldLines.slice(sourceIndex).forEach((line) => appendCode(line, false));
  if (pendingDeletedLines > 0) displayLines.push({ type: "deleted", count: pendingDeletedLines });
  return {
    state: "content",
    content: output.join("\n"),
    lineCount: output.length,
    changedLineCount,
    displayLines,
  };
}

function sourceLines(source: string): string[] {
  if (source.length === 0) return [];
  const lines = source.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}
