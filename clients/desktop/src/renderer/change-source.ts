import type {
  GitHostPullRequestDiffResult,
  GitHostPullRequestIdentityDto,
  GitHostPullRequestSummaryDto,
  ProjectWorktreeDiffResult,
  ProjectWorktreePreImageResult,
  TaskBranchCommitDiffResult,
  TaskWorktreeDiffResult,
  TaskWorktreePreImageResult,
} from "@termloop/contract/current";

export type ChangesOpenSource =
  | { kind: "local" }
  | { kind: "commits" }
  | {
      kind: "pullRequest";
      pullRequest: GitHostPullRequestIdentityDto;
      freshnessGeneration: number;
    };

export type ChangesSource =
  | { kind: "local" }
  | { kind: "commit"; commitId: string }
  | {
      kind: "pullRequest";
      pullRequest: GitHostPullRequestIdentityDto;
      freshnessGeneration: number;
    };

export type CachedDiff = TaskWorktreeDiffResult | ProjectWorktreeDiffResult | TaskBranchCommitDiffResult | GitHostPullRequestDiffResult;
export type CachedPreImage = TaskWorktreePreImageResult | ProjectWorktreePreImageResult;

export const ALL_BRANCH_CHANGES_ID = "all";
export const MAX_RENDERER_DIFFS = 16;
export const MAX_RENDERER_DIFF_BYTES = 4 * 1024 * 1024;

export function pullRequestIdentity(summary: GitHostPullRequestSummaryDto): GitHostPullRequestIdentityDto {
  return {
    provider: summary.provider,
    repository_owner: summary.repository_owner,
    repository_project: summary.repository_project,
    repository_name: summary.repository_name,
    number: summary.number,
  };
}

export function pullRequestKey(identity: GitHostPullRequestIdentityDto): string {
  return [
    identity.provider,
    identity.repository_owner,
    identity.repository_project ?? "",
    identity.repository_name,
    identity.number,
  ].join("|");
}

export function sourceKey(source: ChangesSource): string {
  if (source.kind === "local") return "local";
  if (source.kind === "commit") return `commit:${source.commitId}`;
  return `pullRequest:${pullRequestKey(source.pullRequest)}:${source.freshnessGeneration}`;
}

export function sameSource(left: ChangesSource, right: ChangesSource): boolean {
  return sourceKey(left) === sourceKey(right);
}

export function currentPullRequestSource(
  source: ChangesSource,
  projection: {
    freshness_generation: number;
    matches: readonly GitHostPullRequestIdentityDto[];
  } | undefined,
): boolean {
  return source.kind === "pullRequest"
    && projection?.freshness_generation === source.freshnessGeneration
    && projection.matches.some(
      (match) => pullRequestKey(match) === pullRequestKey(source.pullRequest),
    );
}

export function cacheDiff(
  current: ReadonlyMap<string, CachedDiff>,
  key: string,
  value: CachedDiff,
): ReadonlyMap<string, CachedDiff> {
  const next = cacheLruEntry(current, key, value, MAX_RENDERER_DIFFS);
  while (serializedDiffBytes(next) > MAX_RENDERER_DIFF_BYTES) {
    const oldest = next.keys().next().value as string | undefined;
    if (!oldest) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * Whole-file pre-image content is the same payload class as a patch, so it obeys
 * the same entry and byte ceilings rather than adding a second budget.
 */
export function cachePreImage(
  current: ReadonlyMap<string, CachedPreImage>,
  key: string,
  value: CachedPreImage,
): ReadonlyMap<string, CachedPreImage> {
  const next = cacheLruEntry(current, key, value, MAX_RENDERER_DIFFS);
  while (preImageBytes(next) > MAX_RENDERER_DIFF_BYTES) {
    const oldest = next.keys().next().value as string | undefined;
    if (!oldest) break;
    next.delete(oldest);
  }
  return next;
}

function preImageBytes(cache: ReadonlyMap<string, CachedPreImage>): number {
  let bytes = 0;
  for (const value of cache.values()) bytes += value.content?.length ?? 0;
  return bytes;
}

export function cacheLruEntry<T>(
  current: ReadonlyMap<string, T>,
  key: string,
  value: T,
  maximumEntries: number,
): Map<string, T> {
  const next = new Map(current);
  next.delete(key);
  next.set(key, value);
  while (next.size > maximumEntries) {
    const oldest = next.keys().next().value as string | undefined;
    if (!oldest) break;
    next.delete(oldest);
  }
  return next;
}

export function touchLruEntry<T>(
  current: ReadonlyMap<string, T>,
  key: string,
): ReadonlyMap<string, T> {
  const value = current.get(key);
  let newest: string | undefined;
  for (const candidate of current.keys()) newest = candidate;
  if (value === undefined || newest === key) return current;
  const next = new Map(current);
  next.delete(key);
  next.set(key, value);
  return next;
}

function serializedDiffBytes(values: ReadonlyMap<string, CachedDiff>): number {
  const encoder = new TextEncoder();
  let total = 0;
  for (const [key, value] of values) {
    total += encoder.encode(key).byteLength;
    total += value.patch ? encoder.encode(value.patch).byteLength : 128;
  }
  return total;
}
