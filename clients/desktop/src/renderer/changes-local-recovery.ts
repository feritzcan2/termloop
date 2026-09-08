import type {
  ProjectWorktreeChangeListResult,
  ProjectWorktreeDiffResult,
  ProjectWorktreePreImageResult,
  TaskWorktreeChangeListResult,
  TaskWorktreeDiffResult,
  TaskWorktreePreImageResult,
} from "@termloop/contract/current";

export type LocalChangeListResult = TaskWorktreeChangeListResult | ProjectWorktreeChangeListResult;
export type LocalDiffResult = TaskWorktreeDiffResult | ProjectWorktreeDiffResult;
export type LocalPreImageResult = TaskWorktreePreImageResult | ProjectWorktreePreImageResult;
type LocalChangeEntry = LocalChangeListResult["entries"][number];

type LocalChangeReads = {
  list(subjectId: string): Promise<LocalChangeListResult>;
  diff(subjectId: string, observationId: string, entryId: string): Promise<LocalDiffResult>;
  preImage(subjectId: string, observationId: string, entryId: string): Promise<LocalPreImageResult>;
};

export type RecoveredLocalChange = {
  changes: LocalChangeListResult;
  entry: LocalChangeEntry;
  diff: LocalDiffResult;
  preImage: LocalPreImageResult | undefined;
};

export function localChangeKey(observationId: string | undefined, entryId: string): string {
  return `local:${observationId}:${entryId}`;
}

/** Renew an expired/evicted observation once through the named reads. Electron
 * only preserves the error message across these IPC calls. Never retry the
 * renewal itself: a persistent refusal must remain visible and bounded. */
export async function recoverLocalChange(
  failure: unknown,
  reads: LocalChangeReads,
  subjectId: string,
  previous: LocalChangeListResult,
  selected: LocalChangeEntry,
  includePreImage: boolean,
  isActive: () => boolean,
): Promise<RecoveredLocalChange | undefined> {
  const message = failure instanceof Error ? failure.message : String(failure);
  const stale = message.includes("worktree changed during inspection; inspect again")
    || ("project_id" in previous && message.includes("repository is unavailable"));
  if (!stale) throw failure;
  if (!isActive()) return undefined;
  const changes = await reads.list(subjectId);
  if (!isActive()) return undefined;
  if ("worktree_generation" in previous
    && (!("worktree_generation" in changes) || changes.worktree_generation !== previous.worktree_generation)) {
    throw failure;
  }
  // Entry IDs are list offsets, not file identities. Only unambiguous UTF-8
  // paths on the same side/kind can be selected in the new observation.
  const matches = changes.entries.filter((entry) => selected.path_encoding === "utf8"
    && entry.path_encoding === "utf8"
    && entry.display_path === selected.display_path
    && entry.original_display_path === selected.original_display_path
    && entry.side === selected.side
    && entry.kind === selected.kind);
  const entry = matches.length === 1 ? matches[0] : undefined;
  if (!entry) throw new Error("The selected change is no longer available. Refresh to see the current files.");
  const diff = await reads.diff(subjectId, changes.observation_id, entry.entry_id);
  if (!isActive()) return undefined;
  // A refreshed pre-image must be paired with a new patch from that observation.
  const preImage = includePreImage
    ? await reads.preImage(subjectId, changes.observation_id, entry.entry_id)
    : undefined;
  if (!isActive()) return undefined;
  return { changes, entry, diff, preImage };
}
