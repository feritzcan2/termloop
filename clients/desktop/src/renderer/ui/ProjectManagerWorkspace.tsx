import { useCallback, useEffect, useState } from "react";
import type {
  PlaybookGetResult,
  PlaybookMilestoneDto,
  PlaybookRuntimeResult,
  ProjectManagerBoardResult,
  ProjectManagerCheckRequestResult,
  ProjectManagerEnvironmentSetParams,
  ProjectManagerProbeCreateParams,
  ProjectManagerJiraSearchResult,
  ProjectManagerTaskCreateParams,
  ProjectManagerTaskCreateResult,
  ProjectManagerTaskTrackingSetParams,
  ProjectManagerTicketSaveParams,
  ProjectManagerTicketSaveResult,
  ProjectManagerTicketVersionsResult,
  SprintState,
} from "@termloop/contract/current";

import type { Task } from "../model.js";
import { ProjectManagerOverview } from "./ProjectManagerOverview.js";
import type { ProjectManagerProbeActions } from "./ProjectManagerProbes.js";
import { ProjectManagerTicket } from "./ProjectManagerTicket.js";

export type ProjectManagerWorkspaceActions = {
  loadPlaybook(): Promise<PlaybookGetResult>;
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
  /// Starts one short-lived delivery check of the named Tasks, or of every
  /// tracked Task without any.
  requestCheck(taskIds: string[] | null): Promise<ProjectManagerCheckRequestResult>;
  /// Reads Jira and pull requests for the tracked Tasks now.
  refreshFacts(): Promise<ProjectManagerBoardResult>;
  setEnvironment(params: ProjectManagerEnvironmentSetParams): Promise<ProjectManagerBoardResult>;
  acceptProposal(taskId: string, expectedVersion: number | null): Promise<ProjectManagerTicketSaveResult>;
  dismissProposal(taskId: string): Promise<ProjectManagerBoardResult>;
  /// Writes a probe, approved as written.
  createProbe(params: Omit<ProjectManagerProbeCreateParams, "projectId">): Promise<ProjectManagerBoardResult>;
  approveProbe(probeId: string): Promise<ProjectManagerBoardResult>;
  deleteProbe(probeId: string): Promise<ProjectManagerBoardResult>;
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
  requestCheck(projectId: string, taskIds: string[] | null): Promise<ProjectManagerCheckRequestResult>;
  refreshFacts(projectId: string): Promise<ProjectManagerBoardResult>;
  setEnvironment(projectId: string, params: ProjectManagerEnvironmentSetParams): Promise<ProjectManagerBoardResult>;
  acceptProposal(projectId: string, taskId: string, expectedVersion: number | null): Promise<ProjectManagerTicketSaveResult>;
  dismissProposal(projectId: string, taskId: string): Promise<ProjectManagerBoardResult>;
  createProbe(projectId: string, params: Omit<ProjectManagerProbeCreateParams, "projectId">): Promise<ProjectManagerBoardResult>;
  approveProbe(projectId: string, probeId: string): Promise<ProjectManagerBoardResult>;
  deleteProbe(projectId: string, probeId: string): Promise<ProjectManagerBoardResult>;
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/// The selected Project's board, reloaded whenever its Tasks change (newly
/// read facts and a delivery check's report arrive as a Task change) and
/// replaced by each command's own result.
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

/// The running delivery check that covers a Task, if any.
export function projectManagerTaskCheck(taskId: string, board: ProjectManagerBoardResult | null): ProjectManagerBoardResult["checks"][number] | undefined {
  return board?.checks.find((check) => check.taskIds.includes(taskId));
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

/// The Project Manager stage: the selected Task's ticket and delivery facts
/// beside the Playbook.
export function ProjectManagerStage(props: {
  task: Task | undefined;
  /// The Project's Tasks, for the sprint overview shown without a Task.
  tasks: readonly Task[];
  board: ProjectManagerBoardResult | null;
  milestones: readonly PlaybookMilestoneDto[];
  playbookError: string | undefined;
  playbookRuntime: PlaybookRuntimeResult | null;
  disabled: boolean;
  actions: ProjectManagerWorkspaceActions;
  /// Each command below takes the returned board and answers with the
  /// failure to show, if any.
  setTracking(params: ProjectManagerTaskTrackingSetParams): Promise<string | undefined>;
  saveTicket(params: ProjectManagerTicketSaveParams): Promise<string | undefined>;
  restoreTicket(taskId: string, number: number, expectedVersion: number | null): Promise<string | undefined>;
  setEnvironment(params: ProjectManagerEnvironmentSetParams): Promise<string | undefined>;
  acceptProposal(taskId: string, expectedVersion: number | null): Promise<string | undefined>;
  dismissProposal(taskId: string): Promise<string | undefined>;
  requestCheck(taskIds: string[] | null): Promise<string | undefined>;
  /// Probe commands, each taking the returned board.
  probes: ProjectManagerProbeActions;
  /// Opens a running delivery check's terminal in place of the Task page.
  openCheck(sessionId: string): void;
  selectTask(taskId: string): void;
  addTask(): void;
}) {
  const { task, milestones, actions, board } = props;
  const track = task
    ? projectManagerStepTrack(task.id, milestones, props.playbookRuntime)
    : milestones.map((milestone) => ({ id: milestone.id, title: milestone.title, state: "ahead" as const, evidence: null }));
  const tracking = task ? board?.tracking.find((record) => record.taskId === task.id) : undefined;
  const sprints = board?.sprints ?? [];
  const sprint = sprints.find((candidate) => candidate.id === tracking?.sprintId);
  const activeSprint = sprints.find((candidate) => candidate.state === "active");
  const inActiveSprint = Boolean(task && sprint && sprint.state === "active" && task.status === "open");
  return <div className="pm-workspace">
    <section className="pm-center" aria-label="Task">
      {task ? <ProjectManagerTicket
        key={task.id}
        task={task}
        tracking={tracking}
        facts={board?.facts.find((facts) => facts.taskId === task.id)}
        proposal={board?.proposals.find((proposal) => proposal.taskId === task.id)}
        check={projectManagerTaskCheck(task.id, board)}
        risks={board?.risks.filter((risk) => risk.taskId === task.id) ?? []}
        head={board?.tickets.find((head) => head.taskId === task.id)}
        sprints={sprints}
        activeSprint={activeSprint}
        inActiveSprint={inActiveSprint}
        sprintsFromJira={Boolean(board?.sprintSync)}
        track={track}
        disabled={props.disabled}
        actions={actions}
        saveTicket={props.saveTicket}
        restoreTicket={props.restoreTicket}
        setTracking={props.setTracking}
        setEnvironment={props.setEnvironment}
        acceptProposal={props.acceptProposal}
        dismissProposal={props.dismissProposal}
        requestCheck={props.requestCheck}
        openCheck={props.openCheck}
      /> : <ProjectManagerOverview
        tasks={props.tasks}
        board={board}
        disabled={props.disabled}
        select={props.selectTask}
        checkSprint={() => void props.requestCheck(null)}
        probes={props.probes}
        addTask={props.addTask}
      />}
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

/// A delivery check records its notes as Markdown under `## Observed`,
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
