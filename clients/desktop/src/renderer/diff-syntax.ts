import type { HunkData, HunkTokens, TokenNode } from "react-diff-view";

/// One colored run of a colorized line, as Monaco's static colorizer renders it.
export type ColorizedRun = { className: string; text: string };

/// The old and new side text the patch carries, indexed by line number - 1.
/// Lines outside the hunks are empty so the tokenizer keeps line positions;
/// this matches how react-diff-view's own tokenizer reconstructs each side.
export function diffSideLines(hunks: readonly HunkData[]): { old: string[]; new: string[] } {
  const sides = { old: [] as string[], new: [] as string[] };
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type === "normal") {
        sides.old[change.oldLineNumber - 1] = change.content;
        sides.new[change.newLineNumber - 1] = change.content;
      } else if (change.type === "delete") {
        sides.old[change.lineNumber - 1] = change.content;
      } else {
        sides.new[change.lineNumber - 1] = change.content;
      }
    }
  }
  return { old: Array.from(sides.old, (line) => line ?? ""), new: Array.from(sides.new, (line) => line ?? "") };
}

/// Token nodes for one source line from Monaco's colorized runs. The runs come
/// from colorizing with tab size 1, so each rendered run has exactly as many
/// UTF-16 units as the source span it covers; text is always taken from the
/// source, never from rendered HTML. Any length disagreement yields plain text.
export function lineTokens(source: string, runs: readonly ColorizedRun[]): TokenNode[] {
  const tokens: TokenNode[] = [];
  let offset = 0;
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const end = offset + run.text.length;
    if (end > source.length) return [{ type: "text", value: source }];
    tokens.push({ type: "syntax", className: run.className, value: source.slice(offset, end) });
    offset = end;
  }
  return offset === source.length ? tokens : [{ type: "text", value: source }];
}

/// Syntax tokens for both sides of a diff, given the colorized runs per line.
export function diffSyntaxTokens(
  lines: { old: readonly string[]; new: readonly string[] },
  runs: { old: readonly (readonly ColorizedRun[])[]; new: readonly (readonly ColorizedRun[])[] },
): HunkTokens {
  return {
    old: lines.old.map((line, index) => lineTokens(line, runs.old[index] ?? [])),
    new: lines.new.map((line, index) => lineTokens(line, runs.new[index] ?? [])),
  };
}

/// Monaco colorizer HTML parsed to runs per line. Only class names and text
/// lengths are read; the markup is never inserted into the document.
export function colorizedRuns(html: string): ColorizedRun[][] {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const lines: ColorizedRun[][] = [];
  let current: ColorizedRun[] = [];
  for (const node of Array.from(body.childNodes)) {
    if (node.nodeName === "BR") {
      lines.push(current);
      current = [];
      continue;
    }
    const parts = node instanceof Element ? Array.from(node.children) : [];
    for (const part of parts) current.push({ className: part.className, text: part.textContent ?? "" });
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
