import { useMemo, useState } from "react";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import type { AgentStatus, BranchCommitSummary, GitHostProjection, Session, Task } from "../model.js";
import {
  PROJECT_CONTROL_PHASES,
  deriveProjectControlSnapshot,
  type ProjectControlAction,
} from "../project-control.js";
import { pullRequestIdentity, type ChangesOpenSource } from "../change-source.js";
import { taskSessions } from "./TaskRail.js";
import { Icon } from "./Icon.js";

export type ProjectControlRailProps = {
  tasks: readonly Task[];
  gitHostProjections: readonly GitHostProjection[];
  branchCommitSummaries: readonly BranchCommitSummary[];
  sessionsById: ReadonlyMap<string, Session>;
  statusesById: ReadonlyMap<string, AgentStatus>;
  agentCapabilities: readonly AgentCapabilityDto[];
  disabled: boolean;
  openTask(taskId: string): void;
  prepareWorkspace(taskId: string): void;
  selectSession(sessionId: string): void;
  openChanges(taskId: string, source: ChangesOpenSource): void;
  setTaskClosed(taskId: string, closed: boolean): Promise<void>;
  launchTaskAgent(taskId: string, agentId: string): Promise<string | undefined>;
};

function actionIcon(action: ProjectControlAction): "agent" | "branch" | "external" | "focus" | "task" {
  switch (action.kind) {
    case "startAgent":
    case "openAgent": return "agent";
    case "inspectChanges":
    case "inspectCommits": return "branch";
    case "openPullRequest": return "external";
    case "closeTask": return "task";
    case "prepareWorkspace": return "focus";
  }
}

export function ProjectControlRail(props: ProjectControlRailProps) {
  const [busyActionId, setBusyActionId] = useState<string>();
  const [error, setError] = useState<string>();
  const snapshot = useMemo(() => deriveProjectControlSnapshot(props.tasks.map((task) => ({
    task,
    gitHostProjection: props.gitHostProjections.find((projection) => projection.task_id === task.id),
    branchCommitSummary: props.branchCommitSummaries.find((summary) => summary.task_id === task.id),
    sessions: taskSessions(task, props.sessionsById),
    statusesById: props.statusesById,
  }))), [props.branchCommitSummaries, props.gitHostProjections, props.sessionsById, props.statusesById, props.tasks]);
  const firstAvailableAgent = props.agentCapabilities.find((capability) => capability.available);
  const tasksById = useMemo(
    () => new Map(snapshot.tasks.map((item) => [item.task.id, item])),
    [snapshot.tasks],
  );
  const nextAction = snapshot.inbox[0];
  const laterActions = snapshot.inbox.slice(1);
  const currentTaskId = nextAction?.taskId
    ?? snapshot.tasks.find((item) => item.phase !== "done")?.task.id
    ?? snapshot.tasks[0]?.task.id;

  const runAction = async (item: ProjectControlAction) => {
    if (busyActionId || props.disabled) return;
    setBusyActionId(item.id);
    setError(undefined);
    try {
      switch (item.kind) {
        case "prepareWorkspace":
          props.prepareWorkspace(item.taskId);
          break;
        case "startAgent":
          if (!firstAvailableAgent) throw new Error("No configured Agent is available.");
          await props.launchTaskAgent(item.taskId, firstAvailableAgent.agent_id);
          break;
        case "openAgent":
          if (!item.sessionId) throw new Error("The Agent Session is no longer available.");
          props.selectSession(item.sessionId);
          break;
        case "inspectChanges":
          props.openChanges(item.taskId, { kind: "local" });
          break;
        case "inspectCommits":
          props.openChanges(item.taskId, { kind: "commits" });
          break;
        case "openPullRequest": {
          const projection = props.gitHostProjections.find((candidate) => candidate.task_id === item.taskId);
          if (!item.pullRequest || !projection) throw new Error("The pull-request fact is no longer available.");
          props.openChanges(item.taskId, {
            kind: "pullRequest",
            pullRequest: pullRequestIdentity(item.pullRequest),
            freshnessGeneration: projection.freshness_generation,
          });
          break;
        }
        case "closeTask":
          await props.setTaskClosed(item.taskId, true);
          break;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyActionId(undefined);
    }
  };

  const renderAction = (item: ProjectControlAction, primary: boolean) => {
    const task = tasksById.get(item.taskId)?.task;
    return (
      <button
        type="button"
        className={primary ? "primary" : undefined}
        aria-label={`${item.label}: ${task?.title ?? "Task"}`}
        disabled={props.disabled || Boolean(busyActionId)}
        onClick={() => void runAction(item)}
      >
        <Icon name={actionIcon(item)} />
        <span>
          <small>{task?.jira_url?.slice(task.jira_url.lastIndexOf("/") + 1) ?? "Task"}</small>
          <strong>{item.label}</strong>
          <em title={task?.title}>{task?.title}</em>
          {primary ? <span className="pc-action-reason">{item.summary}</span> : null}
        </span>
        <b>{busyActionId === item.id ? "…" : "›"}</b>
      </button>
    );
  };

  return (
    <section className="project-control-rail" aria-label="Project Control">
      <header className="pc-intro">
        <span className="pc-kicker">Control</span>
        <strong>{snapshot.inbox.length === 0
          ? "Nothing needs you right now"
          : `${snapshot.inbox.length} ${snapshot.inbox.length === 1 ? "task needs" : "tasks need"} you`}</strong>
        <p>{snapshot.inbox.length === 0
          ? "Work in progress will appear here when it needs a decision."
          : "Start with the recommendation below. TermLoop will update the list as facts change."}</p>
      </header>

      <section className="pc-next" aria-label="Recommended next action">
        <div className="pc-section-heading">
          <strong>Do this next</strong>
        </div>
        {error ? <p className="pc-error" role="alert">{error}</p> : null}
        {nextAction ? renderAction(nextAction, true) : <p className="pc-empty">You are caught up.</p>}
      </section>

      {laterActions.length > 0 ? <section className="pc-queue" aria-label="Later actions">
        <div className="pc-section-heading">
          <strong>After that</strong>
          <span>{laterActions.length}</span>
        </div>
        <ol>{laterActions.map((action) => <li key={action.id}>{renderAction(action, false)}</li>)}</ol>
      </section> : null}

      <section className="pc-progress" aria-label="Project status">
        <div className="pc-section-heading"><strong>Project status</strong></div>
        <ol>{PROJECT_CONTROL_PHASES.map((phase) => (
          <li key={phase.id} className={`phase-${phase.id}`}>
            <strong>{snapshot.phases[phase.id].length}</strong>
            <span>{phase.label}</span>
          </li>
        ))}</ol>
        <button type="button" onClick={() => currentTaskId && props.openTask(currentTaskId)} disabled={!currentTaskId}>
          Open current Task details <span aria-hidden="true">›</span>
        </button>
      </section>
    </section>
  );
}
