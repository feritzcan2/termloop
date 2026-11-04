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

/// One `[githost-diag]` line: an event name and identifier/count fields only.
export type GitHostDiagnostic = (event: string, fields: Readonly<Record<string, string | number | boolean | undefined>>) => void;

export const gitHostDiagnostic: GitHostDiagnostic = (event, fields) => {
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.info(`[githost-diag] ${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ""}`);
};

type DiagnosedProjection = Pick<GitHostTaskProjectionDto, "task_id" | "matches" | "freshness" | "freshness_generation" | "reason">;

function projectionFacts(projection: DiagnosedProjection | undefined): string {
  return projection ? `${projection.matches.length}@${projection.freshness_generation}` : "none";
}

/**
 * Per-Task outcome of applying one daemon result to the renderer projection:
 * the previous, incoming, and finally shown match count and generation. Only
 * Tasks whose count moved, or whose shown projection is not the incoming one,
 * are reported, so a steady refresh stays quiet.
 */
export function gitHostApplyDiagnostics(
  requestedTaskIds: readonly string[],
  incoming: readonly DiagnosedProjection[],
  before: readonly DiagnosedProjection[],
  after: readonly DiagnosedProjection[],
): Array<Record<string, string | number | boolean | undefined>> {
  const byTask = (projections: readonly DiagnosedProjection[]) =>
    new Map(projections.map((projection) => [projection.task_id, projection]));
  const incomingByTask = byTask(incoming);
  const beforeByTask = byTask(before);
  const afterByTask = byTask(after);
  return [...new Set(requestedTaskIds)].flatMap((taskId) => {
    const received = incomingByTask.get(taskId);
    const previous = beforeByTask.get(taskId);
    const shown = afterByTask.get(taskId);
    const keptOlder = received !== undefined
      && shown !== undefined
      && (shown.freshness_generation !== received.freshness_generation
        || shown.matches.length !== received.matches.length);
    const countMoved = (previous?.matches.length ?? -1) !== (received?.matches.length ?? -1);
    if (!keptOlder && !countMoved) return [];
    return [{
      task: taskId.slice(0, 8),
      previous: projectionFacts(previous),
      incoming: projectionFacts(received),
      shown: projectionFacts(shown),
      freshness: received?.freshness,
      reason: received?.reason ?? undefined,
      keptOlder,
    }];
  });
}

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
  readonly #diagnose: GitHostDiagnostic;
  readonly #completedByProject = new Map<string, Map<string, CachedTaskRefresh>>();
  #activeProjectId: string | undefined;
  #state: ProjectRefreshState | undefined;

  constructor(
    request: GitHostProjectionRequest,
    apply: GitHostProjectionApply,
    now: () => number = Date.now,
    ttlMs: number = GIT_HOST_REFRESH_TTL_MS,
    diagnose: GitHostDiagnostic = () => {},
  ) {
    this.#request = request;
    this.#apply = apply;
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#diagnose = diagnose;
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
    const source = options.force ? "invalidation" : "automatic";
    if (projectId !== this.#activeProjectId) {
      this.#diagnose("requestIgnored", { project: projectId.slice(0, 8), source, tasks: taskIds.length, reason: "inactiveProject" });
      return Promise.resolve();
    }
    let state = this.#state;
    if (state?.cancelled) state = undefined;
    let skippedFresh = 0;
    let skippedRunning = 0;
    const requested = [...new Set(taskIds)].flatMap((taskId) => {
      const cacheKey = options.cacheKeys?.get(taskId);
      if (!options.force && this.#isFresh(projectId, taskId, cacheKey)) {
        skippedFresh += 1;
        return [];
      }
      if (
        !options.force
        && state?.runningTaskIds.has(taskId)
        && state.runningCacheKeys.get(taskId) === cacheKey
      ) {
        skippedRunning += 1;
        return [];
      }
      return [{ taskId, cacheKey }];
    });
    if (options.force || requested.length > 0) {
      this.#diagnose("request", {
        project: projectId.slice(0, 8),
        source,
        tasks: taskIds.length,
        queued: requested.length,
        skippedFresh,
        skippedRunning,
        joinsInFlight: state?.inFlight !== undefined,
      });
    }
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
        } else {
          this.#diagnose("resultDropped", {
            project: projectId.slice(0, 8),
            tasks: taskIds.length,
            reason: batch ? "superseded" : "cancelled",
          });
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
