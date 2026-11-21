import type { TaskWorktreeChangeEntryDto } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";

import {
  firstUnreviewedEntryId,
  patchLineStats,
  splitDisplayPath,
  nextUnreviewedEntryId,
  reviewProgress,
  reviewedEntries,
  unreviewedSections,
} from "../../src/presentation/worktree-change-review";

const entries: TaskWorktreeChangeEntryDto[] = [
  entry("staged", "one"), entry("unstaged", "two"), entry("untracked", "three"),
];

describe("worktree change review presentation", () => {
  it("keeps reviewed files out of their original sections and reports progress", () => {
    const reviewed = new Set(["two"]);

    expect(unreviewedSections(entries, reviewed)).toEqual([
      expect.objectContaining({ id: "staged", entries: [entries[0]] }),
      expect.objectContaining({ id: "untracked", entries: [entries[2]] }),
    ]);
    expect(reviewedEntries(entries, reviewed)).toEqual([entries[1]]);
    expect(reviewProgress(entries, reviewed)).toEqual({ reviewed: 1, total: 3 });
  });

  it("advances to the next unreviewed file and wraps once", () => {
    expect(firstUnreviewedEntryId(entries, new Set(["one"]))).toBe("two");
    expect(nextUnreviewedEntryId(entries, new Set(["one", "two"]), "two")).toBe("three");
    expect(nextUnreviewedEntryId(entries, new Set(["two", "three"]), "three")).toBe("one");
    expect(nextUnreviewedEntryId(entries, new Set(entries.map((entry) => entry.entry_id)), "three")).toBeUndefined();
  });
});

function entry(side: TaskWorktreeChangeEntryDto["side"], entryId: string): TaskWorktreeChangeEntryDto {
  return {
    entry_id: entryId,
    display_path: `${entryId}.ts`,
    original_display_path: null,
    path_encoding: "utf8",
    side,
    kind: "modified",
    render_state: "available",
  };
}

describe("change header presentation", () => {
  it("counts only hunk lines, not file headers", () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n";
    expect(patchLineStats(patch)).toEqual({ added: 2, removed: 1 });
    expect(patchLineStats(null)).toBeUndefined();
  });

  it("leads with the file name and keeps the directory", () => {
    expect(splitDisplayPath("src/app/task/changes.tsx")).toEqual({ name: "changes.tsx", directory: "src/app/task" });
    expect(splitDisplayPath("README.md")).toEqual({ name: "README.md", directory: "" });
  });
});
