import { useCallback, useEffect, useState } from "react";
import type {
  ProjectEnvironmentDto,
  ProjectManagerBoardResult,
  ProjectManagerCheckRequestResult,
  ProjectManagerEnvironmentSetParams,
  ProjectManagerProbeCreateParams,
  ProjectManagerJiraIssueResult,
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
import { ProjectManagerEnvironments } from "./ProjectManagerEnvironments.js";
import { ProjectManagerOverview } from "./ProjectManagerOverview.js";
import type { ProjectManagerProbeActions } from "./ProjectManagerProbes.js";
import { ProjectManagerTicket } from "./ProjectManagerTicket.js";
import { projectManagerStage, projectManagerStageTrack } from "./project-manager-stage.js";

export type ProjectManagerWorkspaceActions = {
  openTaskSources(): void;
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
  /// Replaces the Project's environments, in delivery order.
  setEnvironments(environments: ProjectEnvironmentDto[]): Promise<ProjectManagerBoardResult>;
  /// Reads the Task's Jira issue as Jira holds it now.
  readJiraIssue(taskId: string): Promise<ProjectManagerJiraIssueResult>;
  /// Replaces the Jira issue's summary and description with the reviewed
  /// ticket version, unless either changed since.
  pushJiraIssue(taskId: string, expectedTicketVersion: number, expectedJiraUpdated: string): Promise<ProjectManagerJiraIssueResult>;
  /// Moves the Jira issue into a sprint mirrored from Jira, or the backlog.
  moveJiraSprint(taskId: string, sprintId: string | null): Promise<ProjectManagerJiraIssueResult>;
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
  setEnvironments(projectId: string, environments: ProjectEnvironmentDto[]): Promise<ProjectManagerBoardResult>;
  readJiraIssue(projectId: string, taskId: string): Promise<ProjectManagerJiraIssueResult>;
  pushJiraIssue(projectId: string, taskId: string, expectedTicketVersion: number, expectedJiraUpdated: string): Promise<ProjectManagerJiraIssueResult>;
  moveJiraSprint(projectId: string, taskId: string, sprintId: string | null): Promise<ProjectManagerJiraIssueResult>;
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

/// The running delivery check that covers a Task, if any.
export function projectManagerTaskCheck(taskId: string, board: ProjectManagerBoardResult | null): ProjectManagerBoardResult["checks"][number] | undefined {
  return board?.checks.find((check) => check.taskIds.includes(taskId));
}

export function jiraIssueKey(url: string | null): string | null {
  if (!url) return null;
  const key = url.split(/[/?#]/).filter(Boolean).at(-1);
  return key && /^[A-Z][A-Z0-9_]*-\d+$/.test(key) ? key : null;
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
/// beside where it stands on its way to production.
export function ProjectManagerStage(props: {
  task: Task | undefined;
  /// The Project's Tasks, for the sprint overview shown without a Task.
  tasks: readonly Task[];
  board: ProjectManagerBoardResult | null;
  disabled: boolean;
  actions: ProjectManagerWorkspaceActions;
  /// Each command below takes the returned board and answers with the
  /// failure to show, if any.
  setTracking(params: ProjectManagerTaskTrackingSetParams): Promise<string | undefined>;
  saveTicket(params: ProjectManagerTicketSaveParams): Promise<string | undefined>;
  restoreTicket(taskId: string, number: number, expectedVersion: number | null): Promise<string | undefined>;
  setEnvironment(params: ProjectManagerEnvironmentSetParams): Promise<string | undefined>;
  setEnvironments(environments: ProjectEnvironmentDto[]): Promise<string | undefined>;
  moveJiraSprint(taskId: string, sprintId: string | null): Promise<string | undefined>;
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
  const { task, actions, board } = props;
  const environments = board?.environments ?? [];
  const track = projectManagerStageTrack(task ? projectManagerStage(task.id, board) : undefined, environments);
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
        checkReason={board?.checkReasons.find((reason) => reason.taskId === task.id)}
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
        moveJiraSprint={props.moveJiraSprint}
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
        checkTasks={(taskIds) => void props.requestCheck(taskIds)}
        probes={props.probes}
        addTask={props.addTask}
      />}
    </section>
    <aside className="pm-playbook" aria-label="Delivery">
      <header>
        <h3>{task ? "Delivery" : "Stages"}</h3>
      </header>
      <ol className="pm-steps">
        {track.map((step) => <li key={step.id} className={`pm-step ${task ? step.state : "ahead"}`} data-step-state={task ? step.state : "ahead"}>
          <span className="pm-step-mark" aria-hidden="true" />
          <div>
            <strong>{step.title}</strong>
            {task && step.detail ? <span>{step.detail}</span> : null}
          </div>
        </li>)}
      </ol>
      <ProjectManagerEnvironments environments={environments} disabled={props.disabled} save={props.setEnvironments} />
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
