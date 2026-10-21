import type { TaskWorktreeChangeEntryDto } from "@termloop/contract/current";
import type { LocalChangeListResult } from "./changes-local-recovery.js";

export type SourceControlSubject = { kind: "project" | "task"; id: string };
export type SourceControlSnapshot = {
  /// The last list the daemon returned; kept while a refresh runs so the
  /// panel does not flash empty on every poll.
  result: LocalChangeListResult | undefined;
  error: string | undefined;
  loading: boolean;
};
export type SourceControlSection = {
  id: "conflicts" | "changes" | "staged" | "untracked";
  title: string;
  entries: readonly TaskWorktreeChangeEntryDto[];
};

const EMPTY: SourceControlSnapshot = { result: undefined, error: undefined, loading: false };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Changes could not be loaded. Try Refresh.";

/** Read-only status observation for one Project checkout or Task worktree.
 * The daemon owns Git; this only repeats the named change-list read and
 * drops responses that arrive after a newer refresh or after disposal. */
export class SourceControlStatus {
  private snapshot = EMPTY;
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = false;

  constructor(private readonly list: () => Promise<LocalChangeListResult>) {}
  getSnapshot = (): SourceControlSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  start(): void { this.active = true; void this.refresh(); }
  dispose(): void { this.active = false; this.generation++; }

  private publish(update: Partial<SourceControlSnapshot>): void {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener());
  }

  async refresh(): Promise<void> {
    if (!this.active) return;
    const generation = ++this.generation;
    this.publish({ loading: true });
    try {
      const result = await this.list();
      if (generation === this.generation) this.publish({ result, error: undefined, loading: false });
    } catch (error) {
      if (generation === this.generation) this.publish({ error: errorMessage(error), loading: false });
    }
  }
}

/// Orca's default order: conflicts pinned first, then working tree changes,
/// the index, and untracked files. A partially staged file appears in both
/// Changes and Staged, exactly as the daemon reports it.
export function sourceControlSections(entries: readonly TaskWorktreeChangeEntryDto[]): SourceControlSection[] {
  const byPath = (left: TaskWorktreeChangeEntryDto, right: TaskWorktreeChangeEntryDto) =>
    left.display_path.localeCompare(right.display_path);
  const conflictPaths = new Set<string>();
  const conflicts: TaskWorktreeChangeEntryDto[] = [];
  for (const entry of entries) {
    if (entry.kind !== "unmerged" || conflictPaths.has(entry.display_path)) continue;
    conflictPaths.add(entry.display_path);
    conflicts.push(entry);
  }
  const rest = entries.filter((entry) => entry.kind !== "unmerged");
  return [
    { id: "conflicts" as const, title: "Merge Changes", entries: conflicts.sort(byPath) },
    { id: "changes" as const, title: "Changes", entries: rest.filter((entry) => entry.side === "unstaged").sort(byPath) },
    { id: "staged" as const, title: "Staged Changes", entries: rest.filter((entry) => entry.side === "staged").sort(byPath) },
    { id: "untracked" as const, title: "Untracked", entries: rest.filter((entry) => entry.side === "untracked").sort(byPath) },
  ].filter((section) => section.entries.length > 0);
}
