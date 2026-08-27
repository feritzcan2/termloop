import type { TaskBranchCommitSummaryDto } from "@termloop/contract/current";

type BranchCommitLoader = (
  projectId: string,
  taskIds: readonly string[],
) => Promise<TaskBranchCommitSummaryDto[]>;

type BranchCommitApply = (
  projectId: string,
  taskIds: readonly string[],
  summaries: readonly TaskBranchCommitSummaryDto[],
) => void;

export class BranchCommitRefreshQueue {
  readonly #pending = new Map<string, Set<string>>();
  #inFlight: Promise<void> | undefined;

  constructor(
    private readonly load: BranchCommitLoader,
    private readonly apply: BranchCommitApply,
    private readonly reportError: (error: unknown) => void,
  ) {}

  request(projectId: string, taskIds: readonly string[]): Promise<void> {
    if (taskIds.length === 0) return Promise.resolve();
    const pending = this.#pending.get(projectId) ?? new Set<string>();
    for (const taskId of taskIds) pending.add(taskId);
    this.#pending.set(projectId, pending);
    this.#inFlight ??= this.#drain().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #drain(): Promise<void> {
    while (this.#pending.size > 0) {
      const next = this.#pending.entries().next();
      if (next.done) return;
      const [projectId, pending] = next.value;
      this.#pending.delete(projectId);
      const taskIds = [...pending];
      try {
        const summaries = await this.load(projectId, taskIds);
        this.apply(projectId, taskIds, summaries);
      } catch (error) {
        this.reportError(error);
      }
    }
  }
}
