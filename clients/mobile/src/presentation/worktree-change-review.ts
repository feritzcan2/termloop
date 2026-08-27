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
