import { describe, expect, it } from "vitest";
import type { TaskBranchCommitListResult, TaskWorktreeChangeEntryDto, TaskWorktreeChangeListResult } from "@termloop/contract/current";
import { changesReviewEntryKeys, changesReviewOwner, changesReviewScope, readChangesReviewed, writeChangesReviewed } from "../src/renderer/changes-reviewed-memory.js";

const entry: TaskWorktreeChangeEntryDto = {
  entry_id: "entry-0", display_path: "src/main.ts", original_display_path: null,
  path_encoding: "utf8", side: "unstaged", kind: "modified", render_state: "available",
};
const local: TaskWorktreeChangeListResult = {
  task_id: "task", observation_id: "changes-1", worktree_generation: 1, entries: [entry], truncated: false,
};
const commits: TaskBranchCommitListResult = {
  task_id: "task", observation_id: "commits-1", branch_id: "branch", branch_name: "feature",
  branch_role: "primary", held_by_task_id: null, base_ref: "main", base_oid: "base-oid", base_evidence: null,
  commits: [{ commit_id: "commit-0", branch_id: "branch", branch_name: "feature", short_oid: "abc123456789",
    subject: "Change", subject_encoding: "utf8", authored_at_epoch_ms: null }], truncated: false,
};

function storage(initial?: string) {
  let value = initial ?? "null";
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
}

describe("reviewed file memory", () => {
  it("round-trips marks without erasing other subjects and persists removal", () => {
    const target = storage();
    const task = changesReviewOwner({ kind: "task", id: "one" });
    const project = changesReviewOwner({ kind: "project", id: "one" });
    writeChangesReviewed(task, new Set(["local\u0000file-a"]), target);
    writeChangesReviewed(project, new Set(["local\u0000file-b"]), target);
    expect(readChangesReviewed(task, target)).toEqual(new Set(["local\u0000file-a"]));
    expect(readChangesReviewed(project, target)).toEqual(new Set(["local\u0000file-b"]));
    writeChangesReviewed(task, new Set(), target);
    expect(readChangesReviewed(task, target).size).toBe(0);
    expect(readChangesReviewed(project, target).size).toBe(1);
  });

  it.each(["broken", "null", "[]", '{"owner":false}'])("tolerates malformed storage: %s", (value) => {
    const target = storage(value);
    expect(readChangesReviewed("owner", target).size).toBe(0);
    writeChangesReviewed("owner", new Set(["file"]), target);
    expect(readChangesReviewed("owner", target)).toEqual(new Set(["file"]));
  });

  it("bounds stored subjects and review marks", () => {
    const target = storage();
    const keys = new Set(Array.from({ length: 2100 }, (_, index) => `file-${index}`));
    for (let i = 0; i < 65; i++) writeChangesReviewed(`owner-${i}`, keys, target);
    expect(readChangesReviewed("owner-0", target).size).toBe(0);
    expect(readChangesReviewed("owner-64", target).size).toBe(2048);
  });

  it("uses file paths and sides instead of observation ordinals", () => {
    const key = changesReviewEntryKeys("local", "obs-1", [entry]).get("entry-0");
    expect(changesReviewEntryKeys("local", "obs-2", [{ ...entry, entry_id: "entry-4" }]).get("entry-4")).toBe(key);
    for (const changed of [
      { ...entry, display_path: "new.ts" },
      { ...entry, side: "staged" as const },
      { ...entry, kind: "renamed" as const, original_display_path: "old.ts" },
    ]) expect(changesReviewEntryKeys("local", "obs-2", [changed]).get("entry-0")).not.toBe(key);
  });

  it("keeps lossy or ambiguous file identities in memory only", () => {
    for (const entries of [
      [{ ...entry, path_encoding: "lossy" as const }],
      [entry, { ...entry, entry_id: "entry-1" }],
    ]) {
      const keys = changesReviewEntryKeys("local", "obs-1", entries);
      expect(new Set(keys.values()).size).toBe(entries.length);
      const target = storage();
      writeChangesReviewed("owner", new Set(keys.values()), target);
      expect(readChangesReviewed("owner", target).size).toBe(0);
    }
  });

  it("isolates local marks when the branch or worktree binding changes", () => {
    const scope = changesReviewScope({ kind: "local" }, local, undefined, "feature");
    expect(changesReviewScope({ kind: "local" }, { ...local, observation_id: "changes-2" }, undefined, "feature")).toBe(scope);
    expect(changesReviewScope({ kind: "local" }, { ...local, worktree_generation: 2 }, undefined, "feature")).not.toBe(scope);
    expect(changesReviewScope({ kind: "local" }, local, undefined, "other")).not.toBe(scope);
  });

  it("tracks commit revisions across reordered ordinal IDs and isolates aggregate/base changes", () => {
    const scope = changesReviewScope({ kind: "commit", commitId: "commit-0" }, undefined, commits, undefined);
    const reordered = { ...commits, observation_id: "commits-2", commits: [{ ...commits.commits[0]!, commit_id: "commit-3" }] };
    expect(changesReviewScope({ kind: "commit", commitId: "commit-3" }, undefined, reordered, undefined)).toBe(scope);
    const source = { kind: "commit", commitId: "all" } as const;
    const aggregate = changesReviewScope(source, undefined, commits, undefined);
    expect(changesReviewScope(source, undefined, reordered, undefined)).toBe(aggregate);
    expect(changesReviewScope(source, undefined, { ...commits, base_oid: "new-base" }, undefined)).not.toBe(aggregate);
    expect(changesReviewScope(source, undefined, { ...commits, branch_id: "other" }, undefined)).not.toBe(aggregate);
    expect(changesReviewScope(source, undefined, { ...commits, commits: [{ ...commits.commits[0]!, short_oid: "new-revision" }] }, undefined)).not.toBe(aggregate);
  });

  it("isolates pull request identity and freshness generations", () => {
    const source = { kind: "pullRequest", freshnessGeneration: 1, pullRequest: {
      provider: "github", repository_owner: "owner", repository_name: "repo", repository_project: null, number: 1,
    } } as const;
    const scope = changesReviewScope(source, undefined, undefined, undefined);
    expect(changesReviewScope({ ...source, freshnessGeneration: 2 }, undefined, undefined, undefined)).not.toBe(scope);
    expect(changesReviewScope({ ...source, pullRequest: { ...source.pullRequest, number: 2 } }, undefined, undefined, undefined)).not.toBe(scope);
  });
});
