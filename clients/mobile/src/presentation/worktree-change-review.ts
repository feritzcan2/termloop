import type { TaskWorktreeChangeEntryDto } from "@termloop/contract/current";

export type WorktreeChangeSection = {
  id: TaskWorktreeChangeEntryDto["side"];
  label: string;
  entries: readonly TaskWorktreeChangeEntryDto[];
};

const sideLabels: Record<TaskWorktreeChangeEntryDto["side"], string> = {
  staged: "Staged",
  unstaged: "Working tree",
  untracked: "Untracked",
};

const sideOrder: readonly TaskWorktreeChangeEntryDto["side"][] = ["staged", "unstaged", "untracked"];

export function unreviewedSections(
  entries: readonly TaskWorktreeChangeEntryDto[],
  reviewedEntryIds: ReadonlySet<string>,
): readonly WorktreeChangeSection[] {
  return sideOrder.flatMap((side) => {
    const sectionEntries = entries.filter((entry) => entry.side === side && !reviewedEntryIds.has(entry.entry_id));
    return sectionEntries.length === 0 ? [] : [{ id: side, label: sideLabels[side], entries: sectionEntries }];
  });
}

export function reviewedEntries(
  entries: readonly TaskWorktreeChangeEntryDto[],
  reviewedEntryIds: ReadonlySet<string>,
): readonly TaskWorktreeChangeEntryDto[] {
  return entries.filter((entry) => reviewedEntryIds.has(entry.entry_id));
}

export function firstUnreviewedEntryId(
  entries: readonly TaskWorktreeChangeEntryDto[],
  reviewedEntryIds: ReadonlySet<string>,
): string | undefined {
  return entries.find((entry) => !reviewedEntryIds.has(entry.entry_id))?.entry_id;
}

export function nextUnreviewedEntryId(
  entries: readonly TaskWorktreeChangeEntryDto[],
  reviewedEntryIds: ReadonlySet<string>,
  currentEntryId: string | undefined,
): string | undefined {
  const currentIndex = currentEntryId === undefined
    ? -1
    : entries.findIndex((entry) => entry.entry_id === currentEntryId);
  const rotated = [...entries.slice(currentIndex + 1), ...entries.slice(0, Math.max(currentIndex + 1, 0))];
  return rotated.find((entry) => !reviewedEntryIds.has(entry.entry_id))?.entry_id;
}

export function reviewProgress(
  entries: readonly TaskWorktreeChangeEntryDto[],
  reviewedEntryIds: ReadonlySet<string>,
): { reviewed: number; total: number } {
  return { reviewed: reviewedEntries(entries, reviewedEntryIds).length, total: entries.length };
}

/// Added and removed line counts of one unified patch, for a glanceable header.
export function patchLineStats(patch: string | null | undefined): { added: number; removed: number } | undefined {
  if (!patch) return undefined;
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (line.startsWith("diff --git")) inHunk = false;
    else if (inHunk && line.startsWith("+")) added += 1;
    else if (inHunk && line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/// Splits a display path into the file name and its directory, so a list can
/// lead with the part a reviewer recognises.
export function splitDisplayPath(path: string): { name: string; directory: string } {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? { name: trimmed, directory: "" } : { name: trimmed.slice(slash + 1), directory: trimmed.slice(0, slash) };
}
