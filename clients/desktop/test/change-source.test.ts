import { describe, expect, it } from "vitest";
import { parseDiff } from "react-diff-view";
import {
  ALL_BRANCH_CHANGES_ID,
  MAX_RENDERER_DIFFS,
  cacheDiff,
  cacheLruEntry,
  currentPullRequestSource,
  pullRequestKey,
  sameSource,
  sourceKey,
  touchLruEntry,
  type ChangesSource,
} from "../src/renderer/change-source.js";

const pullRequest: ChangesSource = {
  kind: "pullRequest",
  freshnessGeneration: 7,
  pullRequest: {
    provider: "azureDevOps",
    repository_owner: "org",
    repository_project: "project",
    repository_name: "repo",
    number: 42,
  },
};

describe("Changes source identity", () => {
  it("keeps PR identity separate from commit-like strings", () => {
    expect(sourceKey(pullRequest)).toContain("pullRequest:azureDevOps|org|project|repo|42:7");
    expect(sameSource(pullRequest, { ...pullRequest })).toBe(true);
    expect(sameSource(pullRequest, { kind: "commit", commitId: pullRequestKey(pullRequest.pullRequest) })).toBe(false);
  });

  it("keeps the combined branch range separate from individual commits", () => {
    expect(sourceKey({ kind: "commit", commitId: ALL_BRANCH_CHANGES_ID })).toBe("commit:all");
    expect(sameSource(
      { kind: "commit", commitId: ALL_BRANCH_CHANGES_ID },
      { kind: "commit", commitId: "commit-0" },
    )).toBe(false);
  });

  it("requires exact current PR membership and freshness", () => {
    expect(currentPullRequestSource(pullRequest, {
      freshness_generation: 7,
      matches: [pullRequest.pullRequest],
    })).toBe(true);
    expect(currentPullRequestSource(pullRequest, {
      freshness_generation: 8,
      matches: [pullRequest.pullRequest],
    })).toBe(false);
    expect(currentPullRequestSource(pullRequest, {
      freshness_generation: 7,
      matches: [],
    })).toBe(false);
  });

  it("bounds the transient renderer diff cache", () => {
    let cache = new Map();
    for (let index = 0; index < MAX_RENDERER_DIFFS + 3; index += 1) {
      cache = new Map(cacheDiff(cache, `entry-${index}`, {
        task_id: "task",
        observation_id: "observation",
        entry_id: `entry-${index}`,
        state: "patch",
        reason: null,
        patch: "diff --git a/a b/a\n",
      }));
    }
    expect(cache.size).toBe(MAX_RENDERER_DIFFS);
    expect(cache.has("entry-0")).toBe(false);
    expect(cache.has(`entry-${MAX_RENDERER_DIFFS + 2}`)).toBe(true);
  });

  it("promotes a read diff before evicting the least recently used entry", () => {
    let cache = new Map<string, { state: string }>([
      ["old", { state: "patch" }],
      ["new", { state: "patch" }],
    ]);
    cache = new Map(touchLruEntry(cache, "old"));
    cache = cacheLruEntry(cache, "latest", { state: "patch" }, 2);
    expect([...cache.keys()]).toEqual(["old", "latest"]);
  });

  it("parses a bounded provider rename patch with display-path spaces", () => {
    const patch = [
      "diff --git a/src/old name.ts b/src/new name.ts",
      "--- a/src/old name.ts",
      "+++ b/src/new name.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const files = parseDiff(patch);
    expect(files).toHaveLength(1);
    expect(files[0]?.hunks).toHaveLength(1);
  });
});
