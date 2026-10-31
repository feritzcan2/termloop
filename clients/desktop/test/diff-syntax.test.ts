// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { parseDiff } from "react-diff-view";
import { colorizedRuns, diffSideLines, diffSyntaxTokens, lineTokens } from "../src/renderer/diff-syntax.js";

const patch = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -2,2 +2,2 @@",
  " keep();",
  "-const a = 1;",
  "+const a = 2;",
  "",
].join("\n");

describe("diff syntax", () => {
  it("rebuilds each side at its line numbers with gaps left empty", () => {
    const [file] = parseDiff(patch);
    expect(diffSideLines(file!.hunks)).toEqual({
      old: ["", "keep();", "const a = 1;"],
      new: ["", "keep();", "const a = 2;"],
    });
  });

  it("slices source text by colorized run lengths, keeping the source characters", () => {
    expect(lineTokens("a\tb <c", [
      { className: "mtk1", text: "a" },
      { className: "mtk5", text: " b " },
      { className: "mtk7", text: "<c" },
    ])).toEqual([
      { type: "syntax", className: "mtk1", value: "a" },
      { type: "syntax", className: "mtk5", value: "\tb " },
      { type: "syntax", className: "mtk7", value: "<c" },
    ]);
  });

  it("falls back to plain text when the runs disagree with the source", () => {
    expect(lineTokens("abc", [{ className: "mtk1", text: "ab" }])).toEqual([{ type: "text", value: "abc" }]);
    expect(lineTokens("abc", [{ className: "mtk1", text: "abcd" }])).toEqual([{ type: "text", value: "abc" }]);
    expect(diffSyntaxTokens({ old: ["x"], new: [] }, { old: [], new: [] }).old).toEqual([[{ type: "text", value: "x" }]]);
  });

  it("reads Monaco colorizer markup as runs per line without trusting its text", () => {
    const html = '<span><span class="mtk6">const</span><span class="mtk1">&nbsp;a&nbsp;&lt;</span></span><br/><span><span></span></span><br/>';
    expect(colorizedRuns(html)).toEqual([
      [{ className: "mtk6", text: "const" }, { className: "mtk1", text: " a <" }],
      [{ className: "", text: "" }],
    ]);
    expect(lineTokens("const a <", colorizedRuns(html)[0]!)).toEqual([
      { type: "syntax", className: "mtk6", value: "const" },
      { type: "syntax", className: "mtk1", value: " a <" },
    ]);
  });
});
