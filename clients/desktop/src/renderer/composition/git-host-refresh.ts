import type { GitHostTaskProjectionDto } from "@termloop/contract/current";

const GIT_HOST_PROJECTION_BATCH_SIZE = 40;

type GitHostProjectionBatch = {
  requestedTaskIds: string[];
  projections: GitHostTaskProjectionDto[];
};

type GitHostProjectionRequest = (
  projectId: string,
  taskIds: string[],
) => Promise<GitHostTaskProjectionDto[]>;

type GitHostProjectionApply = (
  projectId: string,
  requestedTaskIds: readonly string[],
  projections: readonly GitHostTaskProjectionDto[],
) => void;

type ProjectRefreshState = {
  cancelled: boolean;
  pendingTaskIds: Set<string>;
  runningTaskIds: Set<string>;
  inFlight?: Promise<void>;
};

export async function requestGitHostProjectionBatches(
  projectId: string,
  taskIds: readonly string[],
  request: GitHostProjectionRequest,
  shouldContinue: () => boolean = () => true,
): Promise<GitHostProjectionBatch | undefined> {
  const requestedTaskIds = [...new Set(taskIds)];
  if (requestedTaskIds.length === 0 || !shouldContinue()) return undefined;
  const projections: GitHostTaskProjectionDto[] = [];
  for (let offset = 0; offset < requestedTaskIds.length; offset += GIT_HOST_PROJECTION_BATCH_SIZE) {
    if (!shouldContinue()) return undefined;
    projections.push(...await request(
      projectId,
      requestedTaskIds.slice(offset, offset + GIT_HOST_PROJECTION_BATCH_SIZE),
    ));
  }
  if (!shouldContinue()) return undefined;
  return {
    requestedTaskIds,
    projections,
  };
}

/**
 * Keeps one Project refresh in flight, folds overlapping invalidations into it,
 * and logically cancels obsolete work as soon as Project selection changes.
 * The active IPC call remains transport-owned, but no later batch starts and
 * no obsolete response can update the selected projection.
 */
export class GitHostRefreshCoordinator {
  readonly #request: GitHostProjectionRequest;
  readonly #apply: GitHostProjectionApply;
  #activeProjectId: string | undefined;
  #state: ProjectRefreshState | undefined;

  constructor(request: GitHostProjectionRequest, apply: GitHostProjectionApply) {
    this.#request = request;
    this.#apply = apply;
  }

  activateProject(projectId: string | undefined): void {
    if (this.#activeProjectId === projectId) return;
    this.#activeProjectId = projectId;
    if (this.#state) {
      this.#state.cancelled = true;
      this.#state.pendingTaskIds.clear();
    }
  }

  request(projectId: string, taskIds: readonly string[]): Promise<void> {
    if (projectId !== this.#activeProjectId) return Promise.resolve();
    let state = this.#state;
    if (!state || state.cancelled) {
      state = {
        cancelled: false,
        pendingTaskIds: new Set(),
        runningTaskIds: new Set(),
      };
      this.#state = state;
    }
    for (const taskId of taskIds) {
      if (!state.runningTaskIds.has(taskId)) state.pendingTaskIds.add(taskId);
    }
    if (state.pendingTaskIds.size === 0) return state.inFlight ?? Promise.resolve();
    if (state.inFlight) return state.inFlight;
    const inFlight = this.#drain(projectId, state);
    state.inFlight = inFlight;
    return inFlight;
  }

  async #drain(projectId: string, state: ProjectRefreshState): Promise<void> {
    try {
      while (this.#isCurrent(projectId, state) && state.pendingTaskIds.size > 0) {
        const taskIds = [...state.pendingTaskIds];
        state.pendingTaskIds.clear();
        state.runningTaskIds = new Set(taskIds);
        const batch = await requestGitHostProjectionBatches(
          projectId,
          taskIds,
          this.#request,
          () => this.#isCurrent(projectId, state),
        );
        state.runningTaskIds.clear();
        if (batch && this.#isCurrent(projectId, state)) {
          this.#apply(projectId, batch.requestedTaskIds, batch.projections);
        }
      }
    } finally {
      state.runningTaskIds.clear();
      delete state.inFlight;
      if (this.#state === state && state.pendingTaskIds.size === 0) {
        this.#state = undefined;
      }
    }
  }

  #isCurrent(projectId: string, state: ProjectRefreshState): boolean {
    return !state.cancelled
      && this.#state === state
      && projectId === this.#activeProjectId;
  }
}
