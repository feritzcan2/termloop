import type {
  GitHostPullRequestSummaryDto,
  TaskBranchCommitListResult,
  TaskBranchMembershipRole,
  TaskBranchSetDto,
} from "@termloop/contract/current";
import {
  ALL_BRANCH_CHANGES_ID,
  pullRequestIdentity,
  pullRequestKey,
  type ChangesOpenSource,
  type ChangesSource,
} from "./change-source.js";

/**
 * One branch the Changes view can be scoped to: a Task branch the daemon
 * reports, or the head branch of a matched pull request that no Task branch
 * names (a remote-only or deleted branch, readable only through its PRs).
 */
export type ChangesBranchScope = {
  key: string;
  name: string;
  /** Task branch id for `task.branchCommitList`; absent for a PR-only branch. */
  branchId: string | undefined;
  /** The Task's primary binding when the daemon reported no branch set. */
  primaryFallback: boolean;
  checkedOut: boolean;
  role: TaskBranchMembershipRole | undefined;
  pullRequests: readonly GitHostPullRequestSummaryDto[];
};

type ScopeInput = {
  branches: TaskBranchSetDto | undefined;
  primaryBranchName: string | undefined;
  hasWorktree: boolean;
  pullRequests: readonly GitHostPullRequestSummaryDto[] | undefined;
};

export function changesBranchScopes({ branches, primaryBranchName, hasWorktree, pullRequests = [] }: ScopeInput): ChangesBranchScope[] {
  const scopes: ChangesBranchScope[] = [];
  const byName = new Map<string, ChangesBranchScope>();
  const add = (scope: ChangesBranchScope) => {
    if (byName.has(scope.name)) return;
    byName.set(scope.name, scope);
    scopes.push(scope);
  };
  if (branches?.items.length) {
    for (const item of branches.items) {
      if (item.role === "baseBranch") continue;
      add({
        key: `branch:${item.branch_id}`,
        name: item.name,
        branchId: item.branch_id,
        primaryFallback: false,
        checkedOut: item.checked_out || item.branch_id === branches.checked_out_branch_id,
        role: item.role,
        pullRequests: [],
      });
    }
  } else if (primaryBranchName) {
    add({
      key: "branch:primary",
      name: primaryBranchName,
      branchId: undefined,
      primaryFallback: true,
      checkedOut: hasWorktree,
      role: "primary",
      pullRequests: [],
    });
  }
  for (const pullRequest of pullRequests) {
    const name = headBranchName(pullRequest.head_branch);
    let scope = byName.get(name);
    if (!scope) {
      scope = {
        key: `pullRequestHead:${name}`,
        name,
        branchId: undefined,
        primaryFallback: false,
        checkedOut: false,
        role: undefined,
        pullRequests: [],
      };
      add(scope);
    }
    scope.pullRequests = [...scope.pullRequests, pullRequest];
  }
  return scopes
    .map((scope, index) => ({ scope, index }))
    .sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope) || left.index - right.index)
    .map(({ scope }) => scope);
}

/** Checked out first, then branches with a live PR, then the rest. */
function scopeRank(scope: ChangesBranchScope): number {
  if (scope.checkedOut) return 0;
  if (scope.pullRequests.some(livePullRequest)) return 1;
  if (scope.branchId !== undefined || scope.primaryFallback) return 2;
  return 3;
}

export function livePullRequest(pullRequest: GitHostPullRequestSummaryDto): boolean {
  return pullRequest.state === "open" || pullRequest.state === "draft";
}

export function headBranchName(headBranch: string): string {
  return headBranch.startsWith("refs/heads/") ? headBranch.slice("refs/heads/".length) : headBranch;
}

export function scopeHasCommits(scope: ChangesBranchScope): boolean {
  return scope.branchId !== undefined || scope.primaryFallback;
}

export function initialScopeKey(
  scopes: readonly ChangesBranchScope[],
  source: ChangesOpenSource,
  branches: TaskBranchSetDto | undefined,
): string | undefined {
  if (source.kind === "pullRequest") {
    const wanted = pullRequestKey(source.pullRequest);
    const owner = scopes.find((scope) => scope.pullRequests.some(
      (pullRequest) => pullRequestKey(pullRequestIdentity(pullRequest)) === wanted,
    ));
    if (owner) return owner.key;
  }
  if (source.kind === "commits" && source.branchId) {
    const owner = scopes.find((scope) => scope.branchId === source.branchId);
    if (owner) return owner.key;
  }
  return scopes.find((scope) => scope.checkedOut)?.key
    ?? scopes.find((scope) => scope.branchId !== undefined && scope.branchId === branches?.primary_branch_id)?.key
    ?? scopes[0]?.key;
}

/** Without a scope (a Project subject) every source stays visible. */
export function scopeAllowsSource(scope: ChangesBranchScope | undefined, source: ChangesSource): boolean {
  if (!scope) return true;
  if (source.kind === "local") return scope.checkedOut;
  if (source.kind === "commit") return scopeHasCommits(scope);
  const wanted = pullRequestKey(source.pullRequest);
  return scope.pullRequests.some((pullRequest) => pullRequestKey(pullRequestIdentity(pullRequest)) === wanted);
}

export function scopeDefaultSource(
  scope: ChangesBranchScope,
  hasLocalChanges: boolean,
  commitList: TaskBranchCommitListResult | undefined,
  freshnessGeneration: number | undefined,
): ChangesSource {
  if (scope.checkedOut && hasLocalChanges) return { kind: "local" };
  if (scopeHasCommits(scope) && commitList?.commits.length) return { kind: "commit", commitId: ALL_BRANCH_CHANGES_ID };
  const pullRequest = scope.pullRequests.find(livePullRequest) ?? scope.pullRequests[0];
  if (pullRequest && freshnessGeneration !== undefined) {
    return { kind: "pullRequest", pullRequest: pullRequestIdentity(pullRequest), freshnessGeneration };
  }
  return { kind: "local" };
}
