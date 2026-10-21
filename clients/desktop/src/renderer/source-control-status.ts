import type {
  SourceControlBranchDto,
  SourceControlCommitParams,
  SourceControlEntriesParams,
  SourceControlRootParams,
  SourceControlStatusResult,
  SourceControlSyncResult,
  TaskWorktreeChangeEntryDto,
} from "@termloop/contract/current";

/// The Project checkout (`taskId: null`) or one managed Task worktree.
export type SourceControlSubject = { projectId: string; taskId: string | null };
/// Named daemon operations only; the renderer never runs Git itself.
export type SourceControlApi = {
  status(params: SourceControlRootParams): Promise<SourceControlStatusResult>;
  stage(params: SourceControlEntriesParams): Promise<unknown>;
  unstage(params: SourceControlEntriesParams): Promise<unknown>;
  discard(params: SourceControlEntriesParams): Promise<unknown>;
  commit(params: SourceControlCommitParams): Promise<unknown>;
  push(params: SourceControlRootParams): Promise<SourceControlSyncResult>;
  pull(params: SourceControlRootParams): Promise<SourceControlSyncResult>;
  fetch(params: SourceControlRootParams): Promise<SourceControlSyncResult>;
};
export type SourceControlAction = "stage" | "unstage" | "discard" | "commit" | "push" | "pull" | "fetch";
export type SourceControlSnapshot = {
  /// The last status the daemon returned; kept while a refresh runs so the
  /// panel does not flash empty on every poll.
  result: SourceControlStatusResult | undefined;
  error: string | undefined;
  loading: boolean;
  /// The one request in flight; actions never overlap on one checkout.
  busy: SourceControlAction | undefined;
  actionError: string | undefined;
};
export type SourceControlSection = {
  id: "conflicts" | "changes" | "staged" | "untracked";
  title: string;
  entries: readonly TaskWorktreeChangeEntryDto[];
};
/// The one action the primary button offers, in Orca's order of precedence.
export type SourceControlPrimary =
  | { kind: "commit"; enabled: boolean }
  | { kind: "publish" }
  | { kind: "push"; ahead: number }
  | { kind: "pull"; behind: number }
  | { kind: "sync"; ahead: number; behind: number }
  | { kind: "none" };

const EMPTY: SourceControlSnapshot = { result: undefined, error: undefined, loading: false, busy: undefined, actionError: undefined };
const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

/** Status and explicit actions for one Project checkout or Task worktree.
 * Every action re-reads status afterwards, and responses that arrive after a
 * newer refresh or after disposal are dropped. */
export class SourceControlStatus {
  private snapshot = EMPTY;
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = false;

  constructor(private readonly subject: SourceControlSubject, private readonly api: () => SourceControlApi) {}
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

  private get root(): SourceControlRootParams {
    return { projectId: this.subject.projectId, taskId: this.subject.taskId };
  }

  async refresh(): Promise<void> {
    if (!this.active) return;
    const generation = ++this.generation;
    this.publish({ loading: true });
    try {
      const result = await this.api().status(this.root);
      if (generation === this.generation) this.publish({ result, error: undefined, loading: false });
    } catch (error) {
      if (generation === this.generation) this.publish({ error: errorMessage(error, "Changes could not be loaded. Try Refresh."), loading: false });
    }
  }

  stage(entries: readonly TaskWorktreeChangeEntryDto[]): Promise<boolean> {
    return this.entries("stage", entries, (params) => this.api().stage(params));
  }
  unstage(entries: readonly TaskWorktreeChangeEntryDto[]): Promise<boolean> {
    return this.entries("unstage", entries, (params) => this.api().unstage(params));
  }
  discard(entries: readonly TaskWorktreeChangeEntryDto[]): Promise<boolean> {
    return this.entries("discard", entries, (params) => this.api().discard(params));
  }

  /// Commits the index; with `thenPush`, pushes (or publishes) only after the
  /// commit succeeded.
  async commit(message: string, thenPush = false): Promise<boolean> {
    if (!message.trim()) return false;
    const committed = await this.perform("commit", () => this.api().commit({ ...this.root, message }));
    return committed && (!thenPush || this.sync("push"));
  }

  sync(action: "push" | "pull" | "fetch"): Promise<boolean> {
    return this.perform(action, () => this.api()[action](this.root));
  }

  private entries(
    action: "stage" | "unstage" | "discard",
    entries: readonly TaskWorktreeChangeEntryDto[],
    run: (params: SourceControlEntriesParams) => Promise<unknown>,
  ): Promise<boolean> {
    const observationId = this.snapshot.result?.observation_id;
    if (!observationId || !entries.length) return Promise.resolve(false);
    return this.perform(action, () => run({ ...this.root, observationId, entryIds: entries.map((entry) => entry.entry_id) }));
  }

  private async perform(action: SourceControlAction, run: () => Promise<unknown>): Promise<boolean> {
    if (!this.active || this.snapshot.busy) return false;
    this.publish({ busy: action, actionError: undefined });
    let succeeded = true;
    try {
      await run();
    } catch (error) {
      succeeded = false;
      this.publish({ actionError: errorMessage(error, "Git could not finish that action.") });
    }
    this.publish({ busy: undefined });
    await this.refresh();
    return succeeded;
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

/// Commit while anything is staged or a message is being written; otherwise
/// the branch's sync state decides.
export function sourceControlPrimary(
  branch: SourceControlBranchDto | undefined,
  stagedCount: number,
  hasMessage: boolean,
): SourceControlPrimary {
  if (stagedCount > 0 || hasMessage) return { kind: "commit", enabled: stagedCount > 0 && hasMessage };
  if (!branch || branch.head_state !== "attached") return { kind: "none" };
  if (!branch.upstream || branch.upstream_gone) return { kind: "publish" };
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  if (ahead && behind) return { kind: "sync", ahead, behind };
  if (ahead) return { kind: "push", ahead };
  if (behind) return { kind: "pull", behind };
  return { kind: "none" };
}
