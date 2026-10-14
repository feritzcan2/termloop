import type {
  GitHostPullRequestChangeEntryDto,
  TaskBranchCommitChangeEntryDto,
  TaskBranchCommitListResult,
  TaskWorktreeChangeEntryDto,
} from "@termloop/contract/current";
import { ALL_BRANCH_CHANGES_ID, pullRequestKey, type ChangesSource } from "./change-source.js";
import type { LocalChangeListResult } from "./changes-local-recovery.js";

// v1 had no content evidence, so its marks cannot be restored safely.
const STORAGE_KEY = "termloop.changesReviewed.v2";
const MAX_SUBJECTS = 64;
const MAX_KEYS_PER_SUBJECT = 2048;
const VOLATILE_PREFIX = "volatile:";
type ReviewEntry = TaskWorktreeChangeEntryDto | TaskBranchCommitChangeEntryDto | GitHostPullRequestChangeEntryDto;
type ReviewMemory = Record<string, [string, string][]>;

export function changesReviewOwner(
  subject: { kind: "project" | "task"; id: string },
  connectionProfileId = "local",
): string {
  return JSON.stringify([connectionProfileId, subject.kind, subject.id]);
}

/** Read observations and entry/commit ordinals are temporary capabilities, not
 * identities. Each persisted file mark has a digest of the reviewed patch;
 * never store patches or pre-images with these preferences. */
export function changesReviewScope(
  source: ChangesSource,
  local: LocalChangeListResult | undefined,
  commits: TaskBranchCommitListResult | undefined,
  branchName: string | undefined,
): string | undefined {
  if (source.kind === "local") {
    if (!local) return undefined;
    return `local\u0000${JSON.stringify([branchName ?? null, "worktree_generation" in local ? local.worktree_generation : null])}`;
  }
  if (source.kind === "pullRequest") return `pullRequest:${pullRequestKey(source.pullRequest)}`;
  if (!commits) return undefined;
  const revision = source.commitId === ALL_BRANCH_CHANGES_ID
    ? ALL_BRANCH_CHANGES_ID
    : commits.commits.find((commit) => commit.commit_id === source.commitId)?.short_oid;
  if (!revision) return undefined;
  return `commit:${JSON.stringify([commits.branch_id, revision])}`;
}

export function changesReviewEntryKeys(
  scope: string | undefined,
  observationId: string | undefined,
  entries: readonly ReviewEntry[],
): ReadonlyMap<string, string> {
  if (!scope || !observationId) return new Map();
  const identities = entries.map((entry) => JSON.stringify([
    entry.display_path, entry.original_display_path,
    "side" in entry ? entry.side : null, entry.kind,
  ]));
  const counts = new Map<string, number>();
  for (const identity of identities) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  return new Map(entries.map((entry, index) => [entry.entry_id,
    entry.path_encoding === "utf8" && counts.get(identities[index]!) === 1
      ? `${scope}\u0000${identities[index]}`
      : `${VOLATILE_PREFIX}${scope}\u0000${observationId}\u0000${entry.entry_id}`,
  ]));
}

function readMemory(storage: Pick<Storage, "getItem"> | undefined): ReviewMemory {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const parsed: unknown = JSON.parse(source?.getItem(STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).slice(-MAX_SUBJECTS).flatMap(([owner, keys]) => (
      Array.isArray(keys) ? [[owner, persistentKeys(keys)]] : []
    )));
  } catch {
    return {};
  }
}

export function persistableChangesReviewKey(key: string): boolean {
  return key.length > 0 && key.length <= 16_384 && !key.startsWith(VOLATILE_PREFIX);
}

function persistentKeys(keys: readonly unknown[]): [string, string][] {
  return keys.filter((entry): entry is [string, string] => Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === "string" && persistableChangesReviewKey(entry[0])
    && typeof entry[1] === "string" && /^[a-f0-9]{64}$/.test(entry[1])).slice(-MAX_KEYS_PER_SUBJECT);
}

export function readChangesReviewed(owner: string, storage?: Pick<Storage, "getItem">): ReadonlyMap<string, string> {
  return new Map(readMemory(storage)[owner] ?? []);
}

export function writeChangesReviewed(
  owner: string,
  keys: ReadonlyMap<string, string>,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!target) return;
    const memory = readMemory(target);
    delete memory[owner];
    const saved = persistentKeys([...keys]);
    if (saved.length) memory[owner] = saved;
    target.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(memory).slice(-MAX_SUBJECTS))));
  } catch {
    // Storage failures must leave the in-session review usable.
  }
}
