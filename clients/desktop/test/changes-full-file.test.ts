import { describe, expect, it } from "vitest";
import { getChangeKey, parseDiff, type HunkData } from "react-diff-view";
import type { TaskWorktreePreImageState } from "@termloop/contract/current";
import {
  FULL_FILE_MAX_BYTES,
  FULL_FILE_MAX_LINES,
  collapsedLineCount,
  findSourceMismatch,
  fullFileStatusMessage,
  fullFileView,
  preImageRefusal,
  sourceLines,
} from "../src/renderer/changes-full-file.js";

/** A file with one edited line, plus the unified patch Git produces for it. */
function sample(lines = 40, editedLine = 20, trailingNewline = true) {
  const oldLines = Array.from({ length: lines }, (_unused, index) => `const line${index + 1} = ${index + 1};`);
  const newLines = [...oldLines];
  newLines[editedLine - 1] = `const line${editedLine} = ${editedLine * 100}; // edited`;
  const suffix = trailingNewline ? "\n" : "";
  const patch = [
    "diff --git a/sample.ts b/sample.ts",
    "index 1111111..2222222 100644",
    "--- a/sample.ts",
    "+++ b/sample.ts",
    `@@ -${editedLine - 3},7 +${editedLine - 3},7 @@`,
    ...oldLines.slice(editedLine - 4, editedLine - 1).map((line) => ` ${line}`),
    `-${oldLines[editedLine - 1]}`,
    `+${newLines[editedLine - 1]}`,
    ...oldLines.slice(editedLine, editedLine + 3).map((line) => ` ${line}`),
    "",
  ].join("\n");
  return {
    oldSource: oldLines.join("\n") + suffix,
    newSource: newLines.join("\n") + suffix,
    hunks: parseDiff(patch)[0]!.hunks,
    oldLines,
  };
}

/** Old-side line numbers and content the given hunks actually render. */
function renderedOldLines(hunks: readonly HunkData[]): Map<number, string> {
  const rendered = new Map<number, string>();
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      const line = change.type === "insert"
        ? -1
        : change.type === "normal" ? change.oldLineNumber : change.lineNumber;
      if (line >= 1 && !rendered.has(line)) rendered.set(line, change.content);
    }
  }
  return rendered;
}

describe("sourceLines", () => {
  it("does not invent a line for a trailing newline", () => {
    expect(sourceLines("a\nb\n")).toEqual(["a", "b"]);
    expect(sourceLines("a\nb")).toEqual(["a", "b"]);
    expect(sourceLines("a\nb\n\n")).toEqual(["a", "b", ""]);
  });
});

describe("fullFileView", () => {
  it("reconstructs every line of the real old file", () => {
    const { hunks, oldSource, oldLines } = sample(40, 20);
    const view = fullFileView(hunks, oldSource);
    expect(view.state).toBe("fullFile");
    if (view.state !== "fullFile") return;
    expect(view.totalLines).toBe(40);
    expect(view.revealedLines).toBe(33);
    const rendered = renderedOldLines(view.hunks);
    expect(rendered.size).toBe(40);
    for (let line = 1; line <= 40; line++) {
      expect(rendered.get(line)).toBe(oldLines[line - 1]);
    }
  });

  it("is exact for a file with no trailing newline", () => {
    const { hunks, oldSource, oldLines } = sample(40, 20, false);
    const view = fullFileView(hunks, oldSource);
    expect(view.state).toBe("fullFile");
    if (view.state !== "fullFile") return;
    const rendered = renderedOldLines(view.hunks);
    expect(rendered.size).toBe(40);
    expect(rendered.get(40)).toBe(oldLines[39]);
  });

  it("proves the change-focused patch alone cannot show the whole file", () => {
    const { hunks } = sample(40, 20);
    expect(renderedOldLines(hunks).size).toBeLessThan(40);
    expect(collapsedLineCount(hunks, 40)).toBe(33);
  });

  it("rejects the new-side file instead of rendering invented context", () => {
    const { hunks, newSource } = sample(40, 20);
    const view = fullFileView(hunks, newSource);
    expect(view.state).toBe("stale");
    if (view.state !== "stale") return;
    expect(view.mismatch.oldLineNumber).toBe(20);
  });

  it("rejects a source that drifted on a line the patch carries", () => {
    const { hunks, oldSource } = sample(40, 20);
    const view = fullFileView(hunks, oldSource.replace("const line18 = 18;", "const line18 = 999;"));
    expect(view.state).toBe("stale");
  });

  it("accepts the true pre-image", () => {
    const { hunks, oldSource } = sample(40, 20);
    expect(findSourceMismatch(hunks, sourceLines(oldSource))).toBeUndefined();
  });

  it("refuses a source past the line bound", () => {
    const { hunks } = sample(40, 20);
    const view = fullFileView(hunks, "x\n".repeat(FULL_FILE_MAX_LINES + 10));
    expect(view.state).toBe("tooLarge");
  });

  it("refuses a source past the byte bound independently of the line bound", () => {
    const { hunks } = sample(40, 20);
    const view = fullFileView(hunks, `${"x".repeat(FULL_FILE_MAX_BYTES + 10)}\n`);
    expect(view.state).toBe("tooLarge");
    if (view.state !== "tooLarge") return;
    expect(view.lines).toBeLessThanOrEqual(FULL_FILE_MAX_LINES);
    expect(view.bytes).toBeGreaterThan(FULL_FILE_MAX_BYTES);
  });

  it("reports alreadyComplete when the patch already covers the file", () => {
    const { hunks, oldSource } = sample(7, 4);
    expect(fullFileView(hunks, oldSource).state).toBe("alreadyComplete");
    expect(collapsedLineCount(hunks, 7)).toBe(0);
  });

  it("is unavailable rather than throwing for an empty hunk list", () => {
    const view = fullFileView([], "const a = 1;\n");
    expect(view.state).toBe("unavailable");
  });

  it("does not mutate the caller's hunks", () => {
    const { hunks, oldSource } = sample(40, 20);
    const before = JSON.stringify(hunks);
    fullFileView(hunks, oldSource);
    expect(JSON.stringify(hunks)).toBe(before);
  });
});

describe("preImageRefusal", () => {
  // `preImageRefusal` switches exhaustively over the generated union with no
  // `default`, so adding a state to the schema fails `tsc` rather than silently
  // falling back to a generic message. This test covers the values, not that
  // guarantee — the compiler owns it.
  const refusals: TaskWorktreePreImageState[] = [
    "absent",
    "binary",
    "notShown",
    "truncated",
    "nonUtf8",
  ];

  it("treats content as the only expandable state", () => {
    expect(preImageRefusal("content")).toBeUndefined();
    for (const state of refusals) {
      expect(preImageRefusal(state), state).toBeTypeOf("string");
    }
  });

  it("names the byte bound in the truncated message", () => {
    expect(preImageRefusal("truncated")).toContain(FULL_FILE_MAX_BYTES.toLocaleString());
  });
});

describe("fullFileStatusMessage", () => {
  const base = { fullFile: true, unsupportedReason: undefined, loading: false, error: undefined, view: undefined };

  it("says nothing in change-focused mode", () => {
    expect(fullFileStatusMessage({ ...base, fullFile: false })).toBeUndefined();
  });

  it("explains that non-worktree sources cannot expand", () => {
    expect(fullFileStatusMessage({ ...base, unsupportedReason: "The whole file is only available for local worktree changes." })).toMatch(/only available for local worktree/);
  });

  it("announces loading", () => {
    expect(fullFileStatusMessage({ ...base, loading: true })).toMatch(/Loading the full file/);
  });

  it("keeps the diff visible on every refusal", () => {
    const refusals = [
      fullFileStatusMessage({ ...base, error: "The full file could not be read." }),
      fullFileStatusMessage({ ...base, view: { state: "tooLarge", lines: 30_000, bytes: 400_000 } }),
      fullFileStatusMessage({ ...base, view: { state: "unavailable", reason: "Binary content is not shown." } }),
      fullFileStatusMessage({ ...base, unsupportedReason: "The whole file is only available for local worktree changes." }),
    ];
    for (const message of refusals) {
      expect(message).toMatch(/change-focused diff/i);
    }
  });

  it("names the line that no longer matches when the source is stale", () => {
    const message = fullFileStatusMessage({
      ...base,
      view: { state: "stale", mismatch: { oldLineNumber: 42, patchLine: "a", sourceLine: "b" } },
    });
    expect(message).toMatch(/line 42/);
    expect(message).toMatch(/Refresh/);
  });

  it("reports how much was revealed on success", () => {
    const message = fullFileStatusMessage({
      ...base,
      view: { state: "fullFile", hunks: [], revealedLines: 113, totalLines: 120 },
    });
    expect(message).toMatch(/all 120 lines/);
    expect(message).toMatch(/113 were not in the patch/);
  });
});

describe("line comments across a mode switch", () => {
  it("keeps every change key the patch already carried", () => {
    const { hunks, oldSource } = sample(40, 20);
    const keysBefore = changeKeys(hunks);
    // The edited line is a delete/insert pair, which is what a note anchors to.
    expect(keysBefore).toContain("D20");
    expect(keysBefore).toContain("I20");
    expect(keysBefore).toContain("N17");

    const view = fullFileView(hunks, oldSource);
    expect(view.state).toBe("fullFile");
    if (view.state !== "fullFile") return;
    const keysAfter = changeKeys(view.hunks);
    for (const key of keysBefore) {
      expect(keysAfter).toContain(key);
    }
    // And expansion only adds normal-line keys, never a second insert or delete.
    const added = keysAfter.filter((key) => !keysBefore.includes(key));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((key) => key.startsWith("N"))).toBe(true);
  });

  it("keeps change keys after expansion", () => {
    const { hunks, oldSource } = sample(40, 20);
    const keysBefore = changeKeys(hunks);
    const view = fullFileView(hunks, oldSource);
    if (view.state !== "fullFile") throw new Error("expected fullFile");
    for (const key of keysBefore) {
      expect(changeKeys(view.hunks)).toContain(key);
    }
  });
});

/** Every library change key the given hunks render. */
function changeKeys(hunks: readonly HunkData[]): string[] {
  return hunks.flatMap((hunk) => hunk.changes.map((change) => getChangeKey(change)));
}

describe("what the renderer check cannot catch", () => {
  // Measured, not assumed. The patch carries no information about the lines it
  // does not show, so drift there is invisible to any client-side check. This is
  // why freshness stays the daemon observation's responsibility, and why the
  // charter calls the renderer check an integrity guard rather than a freshness
  // mechanism. If this test ever starts failing, that documented claim changed.
  it("does not detect drift on a line outside the patch", () => {
    const { hunks, oldSource } = sample(40, 20);
    // Line 1 is outside the patch: its single hunk covers old lines 17-23.
    const drifted = sourceLines(oldSource);
    drifted[0] = "// drifted outside the patch";

    expect(findSourceMismatch(hunks, drifted)).toBeUndefined();
    expect(fullFileView(hunks, drifted.join("\n")).state).toBe("fullFile");
  });

  it("does detect drift on a line the patch carries", () => {
    const { hunks, oldSource } = sample(40, 20);
    const drifted = sourceLines(oldSource);
    drifted[16] = "// drifted inside the patch";
    expect(findSourceMismatch(hunks, drifted)?.oldLineNumber).toBe(17);
  });
});
