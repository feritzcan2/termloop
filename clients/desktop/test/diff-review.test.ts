import { describe, expect, it } from "vitest";
import { parseDiff, type HunkData } from "react-diff-view";
import {
  changeBlockCount,
  changeFileRole,
  diffEditRanges,
  diffStats,
  hideWhitespaceChanges,
  lineEditRanges,
  markEditRange,
  plainDiffTokens,
  targetChangeBlock,
  withEditMarks,
} from "../src/renderer/diff-review.js";
import { diffSideLines } from "../src/renderer/diff-syntax.js";

const PATCH = `diff --git a/a.cs b/a.cs
--- a/a.cs
+++ b/a.cs
@@ -1,6 +1,6 @@
 using A;
-public async Task Run(
+public Task Run(
 {
-    var x = 1;
+  var x = 1;
 }
-old();
+brandNewCall(withArgs);
`;

const hunks = (): HunkData[] => parseDiff(PATCH)[0]!.hunks;

describe("diff review", () => {
  it("counts added and removed lines", () => {
    expect(diffStats(hunks())).toEqual({ additions: 3, deletions: 3 });
  });

  it("counts change blocks between unchanged lines", () => {
    expect(changeBlockCount(hunks())).toBe(3);
  });

  it("marks only the changed span of a paired line", () => {
    expect(lineEditRanges("public async Task Run(", "public Task Run(")).toEqual({ old: [7, 13], new: [7, 7] });
    expect(lineEditRanges("same", "same")).toBeUndefined();
    // A rewritten line shares too little to be worth marking.
    expect(lineEditRanges("old();", "brandNewCall(withArgs);")).toBeUndefined();
  });

  it("keys edit ranges by each side's line number", () => {
    const ranges = diffEditRanges(hunks());
    expect(ranges.old.get(2)).toEqual([7, 13]);
    expect(ranges.new.has(2)).toBe(false);
    expect(ranges.old.has(6)).toBe(false);
  });

  it("splits tokens at edit edges without changing their text", () => {
    const tokens = [
      { type: "syntax", className: "kw", value: "public " },
      { type: "syntax", className: "kw", value: "async" },
      { type: "text", value: " Task" },
    ];
    const marked = markEditRange(tokens, [5, 13]);
    expect(marked).toEqual([
      { type: "syntax", className: "kw", value: "publi" },
      { type: "edit", children: [
        { type: "syntax", className: "kw", value: "c " },
        { type: "syntax", className: "kw", value: "async" },
        { type: "text", value: " " },
      ] },
      { type: "text", value: "Task" },
    ]);
  });

  it("adds edit marks to plain tokens", () => {
    const parsed = hunks();
    const tokens = withEditMarks(plainDiffTokens(diffSideLines(parsed)), parsed);
    expect(tokens.old[1]).toEqual([
      { type: "text", value: "public " },
      { type: "edit", children: [{ type: "text", value: "async " }] },
      { type: "text", value: "Task Run(" },
    ]);
  });

  it("folds whitespace-only replacements into context", () => {
    const folded = hideWhitespaceChanges(hunks());
    const changes = folded[0]!.changes;
    const indentation = changes.find((change) => change.content.includes("var x"));
    expect(indentation).toMatchObject({ type: "normal", oldLineNumber: 4, newLineNumber: 4, content: "  var x = 1;" });
    expect(diffStats(folded)).toEqual({ additions: 2, deletions: 2 });
  });

  it("drops a hunk whose only change was whitespace", () => {
    const patch = `--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-\tb\n+  b\n`;
    expect(hideWhitespaceChanges(parseDiff(patch)[0]!.hunks)).toEqual([]);
  });

  it("finds the next and previous block from the viewport top", () => {
    const tops = [0, 100, 300];
    expect(targetChangeBlock(tops, 0, 1)).toBe(1);
    expect(targetChangeBlock(tops, 100, 1)).toBe(2);
    expect(targetChangeBlock(tops, 300, 1)).toBeUndefined();
    expect(targetChangeBlock(tops, 300, -1)).toBe(1);
    expect(targetChangeBlock(tops, 0, -1)).toBeUndefined();
  });

  it("tells test and generated files apart from source", () => {
    expect(changeFileRole("services/X.Tests/Logics/FixtureA.cs")).toBe("test");
    expect(changeFileRole("clients/desktop/test/a.test.ts")).toBe("test");
    expect(changeFileRole("src/foo.spec.tsx")).toBe("test");
    expect(changeFileRole("pnpm-lock.yaml")).toBe("generated");
    expect(changeFileRole("contract/generated/typescript/current.ts")).toBe("generated");
    expect(changeFileRole("Form1.Designer.cs")).toBe("generated");
    expect(changeFileRole("services/X/Functions/SessionPaymentUpdate.cs")).toBeUndefined();
    expect(changeFileRole("src/latest.ts")).toBeUndefined();
  });
});
