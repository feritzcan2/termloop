import type { GitHostTaskProjectionDto } from "@termloop/contract/current";

const GIT_HOST_PROJECTION_BATCH_SIZE = 40;
export const GIT_HOST_REFRESH_TTL_MS = 15_000;
const MAX_RETAINED_PROJECTS = 8;
const MAX_RETAINED_TASKS_PER_PROJECT = 256;

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
  pendingCacheKeys: Map<string, string | undefined>;
  runningTaskIds: Set<string>;
  runningCacheKeys: Map<string, string | undefined>;
  inFlight?: Promise<void>;
};

type CachedTaskRefresh = {
  readonly cacheKey: string | undefined;
  readonly completedAtEpochMs: number;
};

export type GitHostRefreshRequestOptions = {
  /** A daemon invalidation must bypass the short renderer cache. */
  readonly force?: boolean;
  /** Changes when Task-owned inputs such as branch identity change. */
  readonly cacheKeys?: ReadonlyMap<string, string>;
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
 * and suppresses repeated automatic reads briefly after a successful result.
 * Obsolete work is logically cancelled as soon as Project selection changes.
 * The active IPC call remains transport-owned, but no later batch starts and
 * no obsolete response can update the selected projection.
 */
export class GitHostRefreshCoordinator {
  readonly #request: GitHostProjectionRequest;
  readonly #apply: GitHostProjectionApply;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #completedByProject = new Map<string, Map<string, CachedTaskRefresh>>();
  #activeProjectId: string | undefined;
  #state: ProjectRefreshState | undefined;

  constructor(
    request: GitHostProjectionRequest,
    apply: GitHostProjectionApply,
    now: () => number = Date.now,
    ttlMs: number = GIT_HOST_REFRESH_TTL_MS,
  ) {
    this.#request = request;
    this.#apply = apply;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  activateProject(projectId: string | undefined): void {
    if (this.#activeProjectId === projectId) return;
    this.#activeProjectId = projectId;
    if (projectId) this.#touchProjectCache(projectId);
    if (this.#state) {
      this.#state.cancelled = true;
      this.#state.pendingTaskIds.clear();
      this.#state.pendingCacheKeys.clear();
    }
  }

  request(
    projectId: string,
    taskIds: readonly string[],
    options: GitHostRefreshRequestOptions = {},
  ): Promise<void> {
    if (projectId !== this.#activeProjectId) return Promise.resolve();
    let state = this.#state;
    if (state?.cancelled) state = undefined;
    const requested = [...new Set(taskIds)].flatMap((taskId) => {
      const cacheKey = options.cacheKeys?.get(taskId);
      if (!options.force && this.#isFresh(projectId, taskId, cacheKey)) return [];
      if (
        !options.force
        && state?.runningTaskIds.has(taskId)
        && state.runningCacheKeys.get(taskId) === cacheKey
      ) return [];
      return [{ taskId, cacheKey }];
    });
    if (requested.length === 0) return state?.inFlight ?? Promise.resolve();
    if (!state) {
      state = {
        cancelled: false,
        pendingTaskIds: new Set(),
        pendingCacheKeys: new Map(),
        runningTaskIds: new Set(),
        runningCacheKeys: new Map(),
      };
      this.#state = state;
    }
    for (const { taskId, cacheKey } of requested) {
      state.pendingTaskIds.add(taskId);
      state.pendingCacheKeys.set(taskId, cacheKey);
    }
    if (state.inFlight) return state.inFlight;
    const inFlight = this.#drain(projectId, state);
    state.inFlight = inFlight;
    return inFlight;
  }

  async #drain(projectId: string, state: ProjectRefreshState): Promise<void> {
    try {
      while (this.#isCurrent(projectId, state) && state.pendingTaskIds.size > 0) {
        const taskIds = [...state.pendingTaskIds];
        const cacheKeys = new Map(taskIds.map((taskId) => [
          taskId,
          state.pendingCacheKeys.get(taskId),
        ]));
        state.pendingTaskIds.clear();
        state.pendingCacheKeys.clear();
        state.runningTaskIds = new Set(taskIds);
        state.runningCacheKeys = cacheKeys;
        const batch = await requestGitHostProjectionBatches(
          projectId,
          taskIds,
          this.#request,
          () => this.#isCurrent(projectId, state),
        );
        if (batch && this.#isCurrent(projectId, state)) {
          this.#apply(projectId, batch.requestedTaskIds, batch.projections);
          this.#recordCompleted(projectId, batch.requestedTaskIds, cacheKeys);
        }
        state.runningTaskIds.clear();
        state.runningCacheKeys.clear();
      }
    } finally {
      state.runningTaskIds.clear();
      state.runningCacheKeys.clear();
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

  #isFresh(projectId: string, taskId: string, cacheKey: string | undefined): boolean {
    const cached = this.#completedByProject.get(projectId)?.get(taskId);
    return cached !== undefined
      && cached.cacheKey === cacheKey
      && this.#now() - cached.completedAtEpochMs < this.#ttlMs;
  }

  #recordCompleted(
    projectId: string,
    taskIds: readonly string[],
    cacheKeys: ReadonlyMap<string, string | undefined>,
  ): void {
    const project = this.#projectCache(projectId);
    const completedAtEpochMs = this.#now();
    for (const taskId of taskIds) {
      project.delete(taskId);
      project.set(taskId, { cacheKey: cacheKeys.get(taskId), completedAtEpochMs });
    }
    while (project.size > MAX_RETAINED_TASKS_PER_PROJECT) {
      const oldest = project.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      project.delete(oldest);
    }
  }

  #projectCache(projectId: string): Map<string, CachedTaskRefresh> {
    this.#touchProjectCache(projectId);
    let project = this.#completedByProject.get(projectId);
    if (!project) {
      project = new Map();
      this.#completedByProject.set(projectId, project);
    }
    while (this.#completedByProject.size > MAX_RETAINED_PROJECTS) {
      const oldest = this.#completedByProject.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#completedByProject.delete(oldest);
    }
    return project;
  }

  #touchProjectCache(projectId: string): void {
    const project = this.#completedByProject.get(projectId);
    if (!project) return;
    this.#completedByProject.delete(projectId);
    this.#completedByProject.set(projectId, project);
  }
}
