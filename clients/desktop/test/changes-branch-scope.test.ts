import { describe, expect, it } from "vitest";
import type {
  GitHostPullRequestSummaryDto,
  TaskBranchCommitListResult,
  TaskBranchMembershipDto,
  TaskBranchSetDto,
} from "@termloop/contract/current";
import {
  changesBranchScopes,
  headBranchName,
  initialScopeKey,
  scopeAllowsSource,
  scopeDefaultSource,
} from "../src/renderer/changes-branch-scope.js";
import { ALL_BRANCH_CHANGES_ID, pullRequestIdentity } from "../src/renderer/change-source.js";

function member(branchId: string, name: string, overrides: Partial<TaskBranchMembershipDto> = {}): TaskBranchMembershipDto {
  return {
    branch_id: branchId,
    name,
    role: "associated",
    held_by_task_id: null,
    checked_out: false,
    base_ref: null,
    base_oid: null,
    base_evidence: null,
    first_observed_worktree_generation: 1,
    rollup_eligible: true,
    ...overrides,
  };
}

function pr(number: number, headBranch: string, state: GitHostPullRequestSummaryDto["state"], baseBranch = "development"): GitHostPullRequestSummaryDto {
  return {
    provider: "azureDevOps",
    host: "dev.azure.com",
    repository_owner: "org",
    repository_project: "project",
    repository_name: "repo",
    number,
    title: `PR ${number}`,
    url: `https://dev.azure.com/org/project/_git/repo/pullrequest/${number}`,
    state,
    merge_commit_oid: null,
    base_branch: baseBranch,
    head_branch: headBranch,
    head_repository_owner: "org",
    head_repository_project: "project",
    head_repository_name: "repo",
    check_rollup: "unknown",
    check_rollup_source: "none",
    review_signal: "unknown",
    review_signal_source: "none",
    merge_conflict: "unknown",
    merge_conflict_source: "none",
    activity_at_epoch_ms: number,
    activity_at_source: "provider",
  } as unknown as GitHostPullRequestSummaryDto;
}

const branches: TaskBranchSetDto = {
  primary_branch_id: "b-primary",
  checked_out_branch_id: "b-work",
  evidence_truncated: false,
  items: [
    member("b-primary", "feature/main", { role: "primary" }),
    member("b-base", "development", { role: "baseBranch" }),
    member("b-work", "feature/work"),
  ],
};

const pullRequests = [
  pr(1, "refs/heads/feature/main", "merged"),
  pr(2, "feature/work", "open"),
  pr(3, "feature/gone", "merged"),
  pr(4, "feature/main", "open", "master"),
];

describe("Changes branch scopes", () => {
  it("groups PRs under their head branch and orders worktree, live PR, local, PR-only", () => {
    const scopes = changesBranchScopes({ branches, primaryBranchName: "feature/main", hasWorktree: true, pullRequests });
    expect(scopes.map((scope) => scope.name)).toEqual(["feature/work", "feature/main", "feature/gone"]);
    expect(scopes[0]).toMatchObject({ branchId: "b-work", checkedOut: true });
    expect(scopes[1]?.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([1, 4]);
    expect(scopes[2]).toMatchObject({ branchId: undefined, primaryFallback: false, checkedOut: false });
  });

  it("never offers the base branch as a scope", () => {
    const scopes = changesBranchScopes({ branches, primaryBranchName: undefined, hasWorktree: true, pullRequests: [] });
    expect(scopes.some((scope) => scope.name === "development")).toBe(false);
  });

  it("falls back to the primary binding when the daemon reports no branch set", () => {
    const scopes = changesBranchScopes({ branches: undefined, primaryBranchName: "feature/main", hasWorktree: true, pullRequests: [pr(5, "feature/main", "open")] });
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ primaryFallback: true, branchId: undefined, checkedOut: true });
    expect(scopes[0]?.pullRequests).toHaveLength(1);
  });

  it("strips the refs/heads/ prefix from a PR head branch", () => {
    expect(headBranchName("refs/heads/a/b")).toBe("a/b");
    expect(headBranchName("a/b")).toBe("a/b");
  });

  it("opens on the branch that owns the requested PR or commit list, else the checked-out branch", () => {
    const scopes = changesBranchScopes({ branches, primaryBranchName: "feature/main", hasWorktree: true, pullRequests });
    const third = pullRequests[2]!;
    expect(initialScopeKey(scopes, { kind: "pullRequest", pullRequest: pullRequestIdentity(third), freshnessGeneration: 1 }, branches))
      .toBe("pullRequestHead:feature/gone");
    expect(initialScopeKey(scopes, { kind: "commits", branchId: "b-primary" }, branches)).toBe("branch:b-primary");
    expect(initialScopeKey(scopes, { kind: "local" }, branches)).toBe("branch:b-work");
  });

  it("limits sources to the scope: local only when checked out, commits only with a local branch, own PRs only", () => {
    const [work, main, gone] = changesBranchScopes({ branches, primaryBranchName: "feature/main", hasWorktree: true, pullRequests });
    const ownPr = { kind: "pullRequest" as const, pullRequest: pullRequestIdentity(pullRequests[1]!), freshnessGeneration: 1 };
    expect(scopeAllowsSource(work, { kind: "local" })).toBe(true);
    expect(scopeAllowsSource(main, { kind: "local" })).toBe(false);
    expect(scopeAllowsSource(gone, { kind: "commit", commitId: ALL_BRANCH_CHANGES_ID })).toBe(false);
    expect(scopeAllowsSource(work, ownPr)).toBe(true);
    expect(scopeAllowsSource(main, ownPr)).toBe(false);
    expect(scopeAllowsSource(undefined, ownPr)).toBe(true);
  });

  it("defaults to local edits, then all branch changes, then a live PR", () => {
    const [work, main, gone] = changesBranchScopes({ branches, primaryBranchName: "feature/main", hasWorktree: true, pullRequests });
    const commits = { commits: [{ commit_id: "c1" }] } as unknown as TaskBranchCommitListResult;
    expect(scopeDefaultSource(work!, true, commits, 3)).toEqual({ kind: "local" });
    expect(scopeDefaultSource(work!, false, commits, 3)).toEqual({ kind: "commit", commitId: ALL_BRANCH_CHANGES_ID });
    expect(scopeDefaultSource(main!, false, undefined, 3)).toMatchObject({ kind: "pullRequest", pullRequest: { number: 4 } });
    expect(scopeDefaultSource(gone!, false, undefined, 3)).toMatchObject({ kind: "pullRequest", pullRequest: { number: 3 } });
  });
});
