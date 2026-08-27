import { describe, expect, it } from "vitest";

import { reconstructFullFile } from "../../src/presentation/worktree-full-file";

describe("worktree full-file reconstruction", () => {
  it("applies the exact patch to the old-side file and preserves untouched lines", () => {
    const result = reconstructFullFile([{
      hunks: [{
        oldStart: 2,
        changes: [
          { type: "normal", content: "before" },
          { type: "delete", content: "old value" },
          { type: "insert", content: "new value" },
          { type: "normal", content: "after" },
        ],
      }],
    }], "first\nbefore\nold value\nafter\nlast\n");

    expect(result).toMatchObject({
      state: "content",
      content: "first\nbefore\nnew value\nafter\nlast",
      lineCount: 5,
      changedLineCount: 1,
    });
    if (result.state === "content") {
      expect(result.displayLines.slice(0, 4)).toEqual([
        { type: "code", content: "first", changed: false },
        { type: "code", content: "before", changed: false },
        { type: "deleted", count: 1 },
        { type: "code", content: "new value", changed: true },
      ]);
    }
  });

  it("reconstructs an added file from an empty pre-image", () => {
    const result = reconstructFullFile([{
      hunks: [{
        oldStart: 0,
        changes: [
          { type: "insert", content: "export const answer = 42;" },
          { type: "insert", content: "" },
        ],
      }],
    }], "");

    expect(result).toMatchObject({
      state: "content",
      content: "export const answer = 42;\n",
      lineCount: 2,
      changedLineCount: 2,
      displayLines: [
        { type: "code", content: "export const answer = 42;", changed: true },
        { type: "code", content: "", changed: true },
      ],
    });
  });

  it("refuses to reconstruct a file when its pre-image no longer matches patch context", () => {
    const result = reconstructFullFile([{
      hunks: [{ oldStart: 1, changes: [{ type: "normal", content: "expected" }] }],
    }], "actually current\n");

    expect(result).toEqual({
      state: "unavailable",
      reason: "The file changed near line 1. Refresh and try again.",
    });
  });
});
