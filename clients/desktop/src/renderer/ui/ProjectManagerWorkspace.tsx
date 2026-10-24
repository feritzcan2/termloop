import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  PlaybookGetResult,
  PlaybookMilestoneDto,
  PlaybookRuntimeResult,
  ProjectManagerBoardResult,
  ProjectManagerJiraSearchResult,
  ProjectManagerTaskCreateParams,
  ProjectManagerTaskCreateResult,
  ProjectManagerTaskTrackingSetParams,
  ProjectManagerTicketSaveParams,
  ProjectManagerTicketSaveResult,
  ProjectManagerTicketVersionsResult,
  SprintState,
} from "@termloop/contract/current";

import type { AgentStatus, Session, Task } from "../model.js";
import { isLiveSession } from "../model.js";
import { taskSessions } from "./TaskRail.js";
import { ProjectManagerTicket } from "./ProjectManagerTicket.js";

export type ProjectManagerWorkspaceActions = {
  loadPlaybook(): Promise<PlaybookGetResult>;
  /// Without an Agent, the Project's Task automation Agent or the last
  /// ordinary Agent launch starts.
  startTaskAgent(taskId: string, agentId?: string): Promise<string | undefined>;
  requestInvestigation(taskId: string): Promise<string | undefined>;
  openTaskSources(): void;
  openPlaybookBuilder(): void;
  openExternal(url: string): void;
  /// The selected Project's local sprints and tracking records.
  loadBoard(): Promise<ProjectManagerBoardResult>;
  createSprint(name: string, state?: SprintState): Promise<ProjectManagerBoardResult>;
  updateSprint(sprintId: string, name: string, state: SprintState): Promise<ProjectManagerBoardResult>;
  deleteSprint(sprintId: string): Promise<ProjectManagerBoardResult>;
  setTracking(params: ProjectManagerTaskTrackingSetParams): Promise<ProjectManagerBoardResult>;
  createTask(params: Omit<ProjectManagerTaskCreateParams, "projectId">): Promise<ProjectManagerTaskCreateResult>;
  searchJira(query: string): Promise<ProjectManagerJiraSearchResult>;
  /// Saves the whole ticket as its next version.
  saveTicket(params: ProjectManagerTicketSaveParams): Promise<ProjectManagerTicketSaveResult>;
  loadTicketVersions(taskId: string): Promise<ProjectManagerTicketVersionsResult>;
  restoreTicket(taskId: string, number: number, expectedVersion: number | null): Promise<ProjectManagerTicketSaveResult>;
};

/// The same commands addressed by Project, as the composition provides them.
export type ProjectManagerProjectActions = {
  loadBoard(projectId: string): Promise<ProjectManagerBoardResult>;
  createSprint(projectId: string, name: string, state?: SprintState): Promise<ProjectManagerBoardResult>;
  updateSprint(projectId: string, sprintId: string, name: string, state: SprintState): Promise<ProjectManagerBoardResult>;
  deleteSprint(projectId: string, sprintId: string): Promise<ProjectManagerBoardResult>;
  setTracking(projectId: string, params: ProjectManagerTaskTrackingSetParams): Promise<ProjectManagerBoardResult>;
  createTask(projectId: string, params: Omit<ProjectManagerTaskCreateParams, "projectId">): Promise<ProjectManagerTaskCreateResult>;
  searchJira(projectId: string, query: string): Promise<ProjectManagerJiraSearchResult>;
  saveTicket(projectId: string, params: ProjectManagerTicketSaveParams): Promise<ProjectManagerTicketSaveResult>;
  loadTicketVersions(projectId: string, taskId: string): Promise<ProjectManagerTicketVersionsResult>;
  restoreTicket(projectId: string, taskId: string, number: number, expectedVersion: number | null): Promise<ProjectManagerTicketSaveResult>;
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/// The selected Project's board, reloaded whenever its Tasks change (an
/// Agent's recorded facts arrive as a Task change) and replaced by each
/// command's own result.
export function useProjectManagerBoard(
  loadBoard: (() => Promise<ProjectManagerBoardResult>) | undefined,
  reloadKey: unknown,
): {
  board: ProjectManagerBoardResult | null;
  error: string | undefined;
  apply(operation: () => Promise<ProjectManagerBoardResult>): Promise<string | undefined>;
} {
  const [board, setBoard] = useState<ProjectManagerBoardResult | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!loadBoard) {
      setBoard(null);
      return;
    }
    let active = true;
    loadBoard().then(
      (result) => { if (active) { setBoard(result); setError(undefined); } },
      (failure: unknown) => { if (active) setError(errorText(failure)); },
    );
    return () => { active = false; };
  }, [loadBoard, reloadKey]);
  const apply = useCallback(async (operation: () => Promise<ProjectManagerBoardResult>) => {
    try {
      setBoard(await operation());
      return undefined;
    } catch (failure) {
      return errorText(failure);
    }
  }, []);
  return { board, error, apply };
}

export type PlaybookStepState = "passed" | "current" | "ahead";

export type PlaybookStepTrack = {
  id: string;
  title: string;
  state: PlaybookStepState;
  evidence: string | null;
};

/// The one Agent a Project Manager works a Task through: its live, ordinary
/// (non-helper) Agent Session, preferring a running one. An Agent stopped when
/// its Task left the active sprint is not one; it has no terminal to attach.
export function projectManagerTaskAgent(task: Task, sessionsById: ReadonlyMap<string, Session>): Session | undefined {
  const agents = taskSessions(task, sessionsById)
    .filter((session) => session.kind === "Agent" && !session.ask_to_source_session_id && isLiveSession(session));
  return agents.find((session) => session.lifecycle_state === "running") ?? agents[0];
}

/// Where one Task stands on the Playbook, from the daemon's runtime: steps
/// before the one it waits at are passed; a done Task passed every step. A
/// Task the runtime does not place yet shows every step ahead.
export function projectManagerStepTrack(
  taskId: string,
  milestones: readonly Pick<PlaybookMilestoneDto, "id" | "title">[],
  runtime: PlaybookRuntimeResult | null,
): PlaybookStepTrack[] {
  const done = runtime?.doneTaskIds.includes(taskId) ?? false;
  const currentIndex = runtime?.steps.findIndex((step) => step.waitingTaskIds.includes(taskId)) ?? -1;
  const currentId = currentIndex >= 0 ? runtime?.steps[currentIndex]?.milestoneId : undefined;
  const currentPosition = currentId ? milestones.findIndex((milestone) => milestone.id === currentId) : -1;
  return milestones.map((milestone, index) => {
    const state: PlaybookStepState = done || (currentPosition >= 0 && index < currentPosition)
      ? "passed"
      : index === currentPosition ? "current" : "ahead";
    const progress = runtime?.steps
      .find((step) => step.milestoneId === milestone.id)
      ?.progress.find((entry) => entry.taskId === taskId);
    return { id: milestone.id, title: milestone.title, state, evidence: progress?.evidence ?? null };
  });
}

export function jiraIssueKey(url: string | null): string | null {
  if (!url) return null;
  const key = url.split(/[/?#]/).filter(Boolean).at(-1);
  return key && /^[A-Z][A-Z0-9_]*-\d+$/.test(key) ? key : null;
}

/// The active Playbook's steps, reloaded whenever the daemon's runtime moves.
export function useProjectManagerPlaybook(
  loadPlaybook: ProjectManagerWorkspaceActions["loadPlaybook"],
  runtimeRevision: number | undefined,
): { milestones: readonly PlaybookMilestoneDto[]; error: string | undefined } {
  const [milestones, setMilestones] = useState<readonly PlaybookMilestoneDto[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    loadPlaybook().then(
      (result) => { if (active) { setMilestones(result.playbook?.milestones ?? []); setError(undefined); } },
      (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); },
    );
    return () => { active = false; };
  }, [loadPlaybook, runtimeRevision]);
  return { milestones, error };
}

export function visibleProjectManagerTasks(tasks: readonly Task[], query: string, showClosed: boolean): Task[] {
  const needle = query.trim().toLowerCase();
  return tasks
    .filter((task) => task.archived_at_epoch_ms === null && (showClosed || task.status === "open"))
    .filter((task) => !needle
      || task.title.toLowerCase().includes(needle)
      || (jiraIssueKey(task.jira_url)?.toLowerCase().includes(needle) ?? false))
    .slice()
    .sort((left, right) => left.rank - right.rank);
}

export function agentStatusLabel(status: AgentStatus["status"] | undefined): string | undefined {
  switch (status) {
    case "working": return "Working";
    case "idle": return "Idle";
    case "awaitingInput": return "Needs input";
    case "compacting": return "Compacting";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    default: return undefined;
  }
}

/// The Project Manager stage: the selected Task's info form, ticket, and its
/// Agent's terminal while it is in the active sprint, beside the Playbook.
export function ProjectManagerStage(props: {
  task: Task | undefined;
  board: ProjectManagerBoardResult | null;
  sessionsById: ReadonlyMap<string, Session>;
  milestones: readonly PlaybookMilestoneDto[];
  playbookError: string | undefined;
  playbookRuntime: PlaybookRuntimeResult | null;
  /// Agent CLIs available to start a Task Agent with.
  agents: readonly { id: string; label: string }[];
  disabled: boolean;
  actions: ProjectManagerWorkspaceActions;
  setTracking(params: ProjectManagerTaskTrackingSetParams): Promise<string | undefined>;
  /// Saves or restores a ticket version and takes the returned board.
  saveTicket(params: ProjectManagerTicketSaveParams): Promise<string | undefined>;
  restoreTicket(taskId: string, number: number, expectedVersion: number | null): Promise<string | undefined>;
  addTask(): void;
  renderTerminal(sessionId: string): ReactNode;
  statusesById?: ReadonlyMap<string, AgentStatus>;
}) {
  const { task, milestones, actions } = props;
  const track = task
    ? projectManagerStepTrack(task.id, milestones, props.playbookRuntime)
    : milestones.map((milestone) => ({ id: milestone.id, title: milestone.title, state: "ahead" as const, evidence: null }));
  const tracking = task ? props.board?.tracking.find((record) => record.taskId === task.id) : undefined;
  const sprints = props.board?.sprints ?? [];
  const sprint = sprints.find((candidate) => candidate.id === tracking?.sprintId);
  const activeSprint = sprints.find((candidate) => candidate.state === "active");
  const inActiveSprint = Boolean(task && sprint && sprint.state === "active" && task.status === "open");
  const taskAgent = task && inActiveSprint ? projectManagerTaskAgent(task, props.sessionsById) : undefined;
  return <div className="pm-workspace">
    <section className="pm-center" aria-label="Task">
      {task ? <ProjectManagerTicket
        key={task.id}
        task={task}
        tracking={tracking}
        head={props.board?.tickets.find((head) => head.taskId === task.id)}
        sprints={sprints}
        activeSprint={activeSprint}
        inActiveSprint={inActiveSprint}
        agent={taskAgent}
        agentStatus={taskAgent ? props.statusesById?.get(taskAgent.id) : undefined}
        track={track}
        agents={props.agents}
        disabled={props.disabled}
        actions={actions}
        saveTicket={props.saveTicket}
        restoreTicket={props.restoreTicket}
        setTracking={props.setTracking}
        renderTerminal={props.renderTerminal}
      /> : <div className="pm-placeholder">
        <h2>No Task selected</h2>
        <p>Plan Tasks into sprints. Each Task in the active sprint gets an Agent that fills in its developer, Jira status, and environments.</p>
        <button type="button" className="primary-button" onClick={props.addTask}>Add Task</button>
      </div>}
    </section>
    <aside className="pm-playbook" aria-label="Playbook">
      <header>
        <h3>Playbook</h3>
        <button type="button" className="secondary-button" onClick={actions.openPlaybookBuilder}>
          {milestones.length === 0 ? "Build with agent" : "Edit"}
        </button>
      </header>
      {props.playbookError ? <p className="form-error" role="alert">{props.playbookError}</p> : null}
      {milestones.length === 0 ? <p className="pm-muted">
        No Playbook yet. The builder researches how this Project ships and proposes the steps.
      </p> : <ol className="pm-steps">
        {track.map((step) => <li key={step.id} className={`pm-step ${step.state}`} data-step-state={step.state}>
          <span className="pm-step-mark" aria-hidden="true" />
          <div>
            <strong>{step.title}</strong>
            {step.evidence ? <span>{step.evidence}</span> : null}
          </div>
        </li>)}
      </ol>}
    </aside>
  </div>;
}

type FindingsSection = { title: string; tone: "observed" | "inferred" | "unknown" | "other"; lines: string[] };

/// The Task Agent records its findings as Markdown under `## Observed`,
/// `## Inferred`, and `## Unknown`; anything else stays a plain section.
export function projectManagerFindingsSections(markdown: string): FindingsSection[] {
  const sections: FindingsSection[] = [];
  let current: FindingsSection | undefined;
  for (const raw of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const heading = raw.match(/^#{1,6}\s+(.+)$/u);
    if (heading) {
      const title = heading[1]!.trim();
      const key = title.toLowerCase();
      current = {
        title,
        tone: key.startsWith("observ") ? "observed" : key.startsWith("infer") ? "inferred" : key.startsWith("unknown") ? "unknown" : "other",
        lines: [],
      };
      sections.push(current);
      continue;
    }
    const line = raw.replace(/^\s*[-*]\s+/u, "").trim();
    if (!line) continue;
    if (!current) {
      current = { title: "Notes", tone: "other", lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }
  return sections;
}
