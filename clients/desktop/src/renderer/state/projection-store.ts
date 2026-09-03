import type { AgentStatus, BranchCommitSummary, ConnectionState, GitHostProjection, Project, ProjectWorktreeSummary, RunConfiguration, RunRuntime, Session, Task } from "../model.js";
import { pullRequestKey } from "../change-source.js";
import type { PlaybookDto, PlaybookRuntimeResult } from "@termloop/contract/current";
import type {
  ConnectionProfileSummary,
  ConnectionSourceState,
} from "../../connection-profile-types.js";

export type ErrorLogEntry = {
  id: number;
  message: string;
  occurredAtEpochMs: number;
};

export type ProjectionState = {
  projects: readonly Project[];
  projectWorktreeSummary?: ProjectWorktreeSummary;
  tasks: readonly Task[];
  sessions: readonly Session[];
  runConfigurations: readonly RunConfiguration[];
  runRuntimes: readonly RunRuntime[];
  runStateRevision: number;
  processingTaskId: string | null;
  playbook: PlaybookDto | null;
  playbookRuntime: PlaybookRuntimeResult | null;
  agentStatuses: readonly AgentStatus[];
  gitHostProjections: readonly GitHostProjection[];
  branchCommitSummaries: readonly BranchCommitSummary[];
  connection: ConnectionState;
  errorLog: readonly ErrorLogEntry[];
  message?: string;
};

type Listener = () => void;
const ERROR_LOG_LIMIT = 50;
type SelectedProjectSnapshot = Pick<ProjectionState,
  | "projectWorktreeSummary"
  | "tasks"
  | "runConfigurations"
  | "runRuntimes"
  | "runStateRevision"
  | "processingTaskId"
  | "playbook"
  | "playbookRuntime"
  | "gitHostProjections"
  | "branchCommitSummaries"
>;
type SourceBaseSnapshot = {
  name: string;
  state: ConnectionSourceState;
  message?: string;
  projects: Project[];
  sessions: Session[];
  agentStatuses: AgentStatus[];
};

export function layoutPreservationProfileIds(
  profiles: readonly ConnectionProfileSummary[],
  sourceState: (profileId: string) => ConnectionSourceState | undefined,
): Set<string> {
  return new Set(profiles
    .filter((profile) => !profile.enabled || sourceState(profile.id) !== "connected")
    .map((profile) => profile.id));
}

export class ProjectionStore {
  #state: ProjectionState = { projects: [], tasks: [], sessions: [], runConfigurations: [], runRuntimes: [], runStateRevision: 0, processingTaskId: null, playbook: null, playbookRuntime: null, agentStatuses: [], gitHostProjections: [], branchCommitSummaries: [], connection: "connecting", errorLog: [] };
  #listeners = new Set<Listener>();
  #nextErrorId = 1;
  #sources = new Map<string, SourceBaseSnapshot>();
  #selectedProjectId: string | undefined;
  #projectSnapshots = new Map<string, SelectedProjectSnapshot>();

  getSnapshot = (): ProjectionState => this.#state;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  applySourceSnapshot(
    profileId: string,
    name: string,
    projects: Project[],
    sessions: Session[],
    agentStatuses: AgentStatus[],
  ): void {
    const scope = <T extends { connectionProfileName?: string; connectionState?: ConnectionSourceState }>(
      values: T[],
    ): T[] => values.map((value) => ({
      ...value,
      connectionProfileName: name,
      connectionState: "connected" as const,
    }));
    this.#sources.set(profileId, {
      name,
      state: "connected",
      projects: scope(projects),
      sessions: scope(sessions),
      agentStatuses: scope(agentStatuses),
    });
    this.#rebuildSourceProjection();
  }

  setSourceConnection(
    profileId: string,
    name: string,
    state: ConnectionSourceState,
    message?: string,
  ): void {
    const previous = this.#sources.get(profileId);
    if (previous
      && previous.name === name
      && previous.state === state
      && previous.message === message) return;
    const updateScope = <T extends { connectionState?: ConnectionSourceState }>(values: T[]): T[] => (
      values.map((value) => ({ ...value, connectionState: state }))
    );
    this.#sources.set(profileId, {
      name,
      state,
      ...(message ? { message } : {}),
      projects: updateScope(previous?.projects ?? []),
      sessions: updateScope(previous?.sessions ?? []),
      agentStatuses: updateScope(previous?.agentStatuses ?? []),
    });
    this.#rebuildSourceProjection();
  }

  retainSources(profileIds: ReadonlySet<string>): void {
    let changed = false;
    for (const profileId of [...this.#sources.keys()]) {
      if (!profileIds.has(profileId)) {
        this.#sources.delete(profileId);
        changed = true;
      }
    }
    if (changed) this.#rebuildSourceProjection();
  }

  sourceState(profileId: string): ConnectionSourceState | undefined {
    return this.#sources.get(profileId)?.state;
  }

  sourceName(profileId: string): string | undefined {
    return this.#sources.get(profileId)?.name;
  }

  gitHostProjectionsForProject(projectId: string): readonly GitHostProjection[] {
    return this.#snapshotForProject(projectId)?.gitHostProjections ?? [];
  }

  branchCommitSummariesForProject(projectId: string): readonly BranchCommitSummary[] {
    return this.#snapshotForProject(projectId)?.branchCommitSummaries ?? [];
  }

  activateProjectSnapshot(projectId: string | undefined): void {
    if (this.#selectedProjectId === projectId) return;
    if (this.#selectedProjectId) {
      this.#projectSnapshots.set(this.#selectedProjectId, selectedProjectSnapshot(this.#state));
    }
    this.#selectedProjectId = projectId;
    this.#applyProjectSnapshot(projectId ? this.#projectSnapshots.get(projectId) : undefined);
  }

  applySelectedProjectSnapshot(projectId: string, tasks: Task[], gitHostProjections: GitHostProjection[] = [], branchCommitSummaries: BranchCommitSummary[] = [], projectWorktreeSummary?: ProjectWorktreeSummary, runConfigurations: RunConfiguration[] = [], runRuntimes: RunRuntime[] = [], runStateRevision = 0, processingTaskId: string | null = null, playbook: PlaybookDto | null = null, playbookRuntime: PlaybookRuntimeResult | null = null): void {
    const snapshot: SelectedProjectSnapshot = {
      tasks: [...tasks],
      gitHostProjections: [...gitHostProjections],
      branchCommitSummaries: [...branchCommitSummaries],
      ...(projectWorktreeSummary ? { projectWorktreeSummary } : {}),
      runConfigurations: [...runConfigurations],
      runRuntimes: [...runRuntimes],
      runStateRevision,
      processingTaskId,
      playbook,
      playbookRuntime,
    };
    this.#projectSnapshots.set(projectId, snapshot);
    if (this.#selectedProjectId === undefined) this.#selectedProjectId = projectId;
    if (this.#selectedProjectId === projectId) this.#applyProjectSnapshot(snapshot);
  }

  applySnapshot(projects: Project[], tasks: Task[], sessions: Session[], agentStatuses: AgentStatus[], gitHostProjections: GitHostProjection[] = [], branchCommitSummaries: BranchCommitSummary[] = [], projectWorktreeSummary?: ProjectWorktreeSummary, runConfigurations: RunConfiguration[] = [], runRuntimes: RunRuntime[] = [], runStateRevision = 0, processingTaskId: string | null = null, playbook: PlaybookDto | null = null, playbookRuntime: PlaybookRuntimeResult | null = null): void {
    this.#state = {
      projects: [...projects],
      ...(projectWorktreeSummary ? { projectWorktreeSummary } : {}),
      tasks: [...tasks],
      sessions: [...sessions],
      runConfigurations: [...runConfigurations],
      runRuntimes: [...runRuntimes],
      runStateRevision,
      processingTaskId,
      playbook,
      playbookRuntime,
      agentStatuses: [...agentStatuses],
      gitHostProjections: [...gitHostProjections],
      branchCommitSummaries: [...branchCommitSummaries],
      connection: "connected",
      errorLog: this.#state.errorLog,
    };
    this.#emit();
  }

  applyBranchCommitPatch(requestedIds: readonly string[], summaries: readonly BranchCommitSummary[]): void {
    const requested = new Set(requestedIds);
    const currentByTask = new Map(this.#state.branchCommitSummaries.map((summary) => [summary.task_id, summary]));
    const next = this.#state.branchCommitSummaries.filter((current) => !requested.has(current.task_id));
    for (const summary of summaries) {
      const current = currentByTask.get(summary.task_id);
      next.push(current && branchCommitSummaryEqual(current, summary) ? current : summary);
    }
    next.sort((left, right) => left.task_id.localeCompare(right.task_id));
    if (next.length === this.#state.branchCommitSummaries.length
      && next.every((summary, index) => summary === this.#state.branchCommitSummaries[index])) return;
    this.#state = { ...this.#state, branchCommitSummaries: next };
    this.#emit();
  }

  applyGitHostPatch(requestedIds: readonly string[], projections: readonly GitHostProjection[]): void {
    const requested = new Set(requestedIds);
    const incoming = new Map(projections.map((projection) => [projection.task_id, projection]));
    const currentByTask = new Map(
      this.#state.gitHostProjections.map((projection) => [projection.task_id, projection]),
    );
    const next = this.#state.gitHostProjections.filter((current) => !requested.has(current.task_id));
    for (const projection of incoming.values()) {
      const current = currentByTask.get(projection.task_id);
      if (current && gitHostProjectionSupersedes(current, projection)) {
        next.push(current);
      } else {
        next.push(current && gitHostProjectionEqual(current, projection) ? current : projection);
      }
    }
    next.sort((left, right) => left.task_id.localeCompare(right.task_id));
    if (
      next.length === this.#state.gitHostProjections.length
      && next.every((projection, index) => {
        const current = this.#state.gitHostProjections[index];
        return current !== undefined && gitHostProjectionEqual(projection, current);
      })
    ) return;
    this.#state = { ...this.#state, gitHostProjections: next };
    this.#emit();
  }

  applyTaskPatch(requestedIds: readonly string[], tasks: readonly Task[]): void {
    const requested = new Set(requestedIds);
    const incoming = new Map(tasks.map((task) => [task.id, task]));
    let changed = false;
    const next = this.#state.tasks.flatMap((current) => {
      if (!requested.has(current.id)) return [current];
      const replacement = incoming.get(current.id);
      incoming.delete(current.id);
      if (!replacement) {
        changed = true;
        return [];
      }
      if (taskProjectionEqual(current, replacement)) return [current];
      changed = true;
      return [replacement];
    });
    if (incoming.size > 0) {
      changed = true;
      next.push(...incoming.values());
      next.sort((left, right) => left.rank - right.rank);
    }
    if (!changed) return;
    this.#state = { ...this.#state, tasks: next };
    this.#emit();
  }

  upsertSession(session: Session): void {
    const index = this.#state.sessions.findIndex((current) => current.id === session.id);
    if (index >= 0 && JSON.stringify(this.#state.sessions[index]) === JSON.stringify(session)) return;
    const sessions = [...this.#state.sessions];
    if (index >= 0) sessions[index] = session;
    else sessions.push(session);
    this.#state = { ...this.#state, sessions };
    this.#emit();
  }

  setConnection(connection: ConnectionState, message?: string): void {
    this.#state = message
      ? { ...this.#state, connection, message, errorLog: this.#appendError(message) }
      : { projects: this.#state.projects, ...(this.#state.projectWorktreeSummary ? { projectWorktreeSummary: this.#state.projectWorktreeSummary } : {}), tasks: this.#state.tasks, sessions: this.#state.sessions, runConfigurations: this.#state.runConfigurations, runRuntimes: this.#state.runRuntimes, runStateRevision: this.#state.runStateRevision, processingTaskId: this.#state.processingTaskId, playbook: this.#state.playbook, playbookRuntime: this.#state.playbookRuntime, agentStatuses: this.#state.agentStatuses, gitHostProjections: this.#state.gitHostProjections, branchCommitSummaries: this.#state.branchCommitSummaries, connection, errorLog: this.#state.errorLog };
    this.#emit();
  }

  setMessage(message?: string): void {
    this.#state = message
      ? { ...this.#state, message, errorLog: this.#appendError(message) }
      : { projects: this.#state.projects, ...(this.#state.projectWorktreeSummary ? { projectWorktreeSummary: this.#state.projectWorktreeSummary } : {}), tasks: this.#state.tasks, sessions: this.#state.sessions, runConfigurations: this.#state.runConfigurations, runRuntimes: this.#state.runRuntimes, runStateRevision: this.#state.runStateRevision, processingTaskId: this.#state.processingTaskId, playbook: this.#state.playbook, playbookRuntime: this.#state.playbookRuntime, agentStatuses: this.#state.agentStatuses, gitHostProjections: this.#state.gitHostProjections, branchCommitSummaries: this.#state.branchCommitSummaries, connection: this.#state.connection, errorLog: this.#state.errorLog };
    this.#emit();
  }

  clearErrorLog(): void {
    if (this.#state.errorLog.length === 0) return;
    this.#state = { ...this.#state, errorLog: [] };
    this.#emit();
  }

  #appendError(message: string): readonly ErrorLogEntry[] {
    const errorLog = [...this.#state.errorLog, {
      id: this.#nextErrorId,
      message,
      occurredAtEpochMs: Date.now(),
    }];
    this.#nextErrorId += 1;
    return errorLog.slice(-ERROR_LOG_LIMIT);
  }

  #applyProjectSnapshot(snapshot: SelectedProjectSnapshot | undefined): void {
    const { projectWorktreeSummary: _previousSummary, ...previous } = this.#state;
    this.#state = {
      ...previous,
      ...(snapshot ?? emptySelectedProjectSnapshot()),
    };
    this.#emit();
  }

  #snapshotForProject(projectId: string): SelectedProjectSnapshot | undefined {
    return this.#selectedProjectId === projectId
      ? selectedProjectSnapshot(this.#state)
      : this.#projectSnapshots.get(projectId);
  }

  #rebuildSourceProjection(): void {
    const sources = [...this.#sources.entries()].sort(([left], [right]) => (
      left === "local" ? -1 : right === "local" ? 1 : left.localeCompare(right)
    ));
    const connected = sources.some(([, source]) => source.state === "connected");
    const connecting = sources.some(([, source]) => source.state === "connecting");
    this.#state = {
      ...this.#state,
      projects: sources.flatMap(([, source]) => source.projects),
      sessions: sources.flatMap(([, source]) => source.sessions),
      agentStatuses: sources.flatMap(([, source]) => source.agentStatuses),
      connection: connected ? "connected" : connecting ? "connecting" : "connectionLost",
    };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function selectedProjectSnapshot(state: ProjectionState): SelectedProjectSnapshot {
  return {
    ...(state.projectWorktreeSummary ? { projectWorktreeSummary: state.projectWorktreeSummary } : {}),
    tasks: state.tasks,
    runConfigurations: state.runConfigurations,
    runRuntimes: state.runRuntimes,
    runStateRevision: state.runStateRevision,
    processingTaskId: state.processingTaskId,
    playbook: state.playbook,
    playbookRuntime: state.playbookRuntime,
    gitHostProjections: state.gitHostProjections,
    branchCommitSummaries: state.branchCommitSummaries,
  };
}

function emptySelectedProjectSnapshot(): SelectedProjectSnapshot {
  return {
    tasks: [],
    runConfigurations: [],
    runRuntimes: [],
    runStateRevision: 0,
    processingTaskId: null,
    playbook: null,
    playbookRuntime: null,
    gitHostProjections: [],
    branchCommitSummaries: [],
  };
}

function branchCommitSummaryEqual(left: BranchCommitSummary, right: BranchCommitSummary): boolean {
  return left.task_id === right.task_id
    && left.count === right.count
    && left.base_ref === right.base_ref
    && left.not_in_base.count === right.not_in_base.count
    && left.not_in_base.base_ref === right.not_in_base.base_ref
    && left.not_in_base.freshness === right.not_in_base.freshness
    && left.not_in_base.reason === right.not_in_base.reason
    && left.freshness === right.freshness
    && left.reason === right.reason;
}

function taskProjectionEqual(left: Task, right: Task): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function gitHostProjectionEqual(left: GitHostProjection, right: GitHostProjection): boolean {
  return left.task_id === right.task_id
    && left.branch_name === right.branch_name
    && left.repository_provider === right.repository_provider
    && left.repository_host === right.repository_host
    && left.repository_owner === right.repository_owner
    && left.repository_project === right.repository_project
    && left.repository_name === right.repository_name
    && left.quality === right.quality
    && left.freshness === right.freshness
    && left.reason === right.reason
    && left.truncated === right.truncated
    && left.candidate_truncated === right.candidate_truncated
    && left.freshness_generation === right.freshness_generation
    && left.last_success_observed_at_epoch_ms === right.last_success_observed_at_epoch_ms
    && left.last_attempt_observed_at_epoch_ms === right.last_attempt_observed_at_epoch_ms
    && left.matches.length === right.matches.length
    && left.matches.every((match, index) => {
      const other = right.matches[index];
      return other !== undefined
        && Object.keys(match).every((key) => (
          match[key as keyof typeof match] === other[key as keyof typeof other]
        ));
    });
}

function gitHostProjectionSupersedes(current: GitHostProjection, incoming: GitHostProjection): boolean {
  if (current.freshness_generation !== incoming.freshness_generation) {
    return current.freshness_generation > incoming.freshness_generation;
  }
  if (current.matches.length <= incoming.matches.length) return false;
  const currentMatches = new Set(current.matches.map(pullRequestKey));
  return incoming.matches.every((match) => currentMatches.has(pullRequestKey(match)));
}

export const projectionStore = new ProjectionStore();
