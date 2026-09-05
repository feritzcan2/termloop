import { useMemo, useState } from "react";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import type { AgentStatus, BranchCommitSummary, GitHostProjection, Session, Task } from "../model.js";
import {
  PROJECT_CONTROL_PHASES,
  deriveProjectControlSnapshot,
  type ProjectControlAction,
  type ProjectControlTask,
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

function ProjectControlTaskCard({ item, openTask }: {
  item: ProjectControlTask;
  openTask(taskId: string): void;
}) {
  const visibleFacts = item.facts.filter((fact) => fact.id !== "checks" && fact.id !== "review").slice(0, 4);
  return (
    <button
      type="button"
      className={`pc-task phase-${item.phase}`}
      aria-label={`Open ${item.task.title}`}
      onClick={() => openTask(item.task.id)}
    >
      <span className="pc-task-heading">
        <strong title={item.task.title}>{item.task.title}</strong>
        <small>{item.task.jira_url?.slice(item.task.jira_url.lastIndexOf("/") + 1) ?? item.phaseLabel}</small>
      </span>
      <span className="pc-facts" aria-label="Current facts">
        {visibleFacts.map((fact) => (
          <span key={fact.id} className={`pc-fact ${fact.tone}`} title={fact.detail}>
            <i aria-hidden="true" />{fact.label}: {fact.value}
          </span>
        ))}
      </span>
    </button>
  );
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

  return (
    <section className="project-control-rail" aria-label="Project Control">
      <header className="pc-intro">
        <span className="pc-kicker">Project Control</span>
        <strong>Current facts, one next action.</strong>
        <p>No background Agent or editable pipeline. The view is rebuilt from Task, worktree, Agent, commit, and provider facts.</p>
      </header>

      <section className="pc-inbox" aria-label="Action Inbox">
        <div className="pc-section-heading">
          <strong>Action Inbox</strong>
          <span>{snapshot.inbox.length}</span>
        </div>
        {error ? <p className="pc-error" role="alert">{error}</p> : null}
        {snapshot.inbox.length === 0 ? (
          <p className="pc-empty">Nothing needs a decision right now.</p>
        ) : (
          <ol>
            {snapshot.inbox.map((action) => {
              const item = tasksById.get(action.taskId);
              return (
                <li key={action.id}>
                  <button type="button" disabled={props.disabled || Boolean(busyActionId)} onClick={() => void runAction(action)}>
                    <Icon name={actionIcon(action)} />
                    <span><strong>{action.label}</strong><small>{item?.task.title}</small><em>{action.summary}</em></span>
                    <b>{busyActionId === action.id ? "…" : "›"}</b>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <div className="pc-phases" aria-label="Delivery phases">
        {PROJECT_CONTROL_PHASES.map((phase) => {
          const tasks = snapshot.phases[phase.id];
          return (
            <section key={phase.id} className={`pc-phase phase-${phase.id}`} aria-label={`${phase.label} Tasks`}>
              <div className="pc-section-heading">
                <strong>{phase.label}</strong>
                <span>{tasks.length}</span>
              </div>
              {tasks.length === 0 ? <i className="pc-phase-empty" aria-hidden="true" /> : tasks.map((item) => (
                <ProjectControlTaskCard key={item.task.id} item={item} openTask={props.openTask} />
              ))}
            </section>
          );
        })}
      </div>
    </section>
  );
}
