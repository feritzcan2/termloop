import type { DeliveryRiskDto, DeliveryRiskKind, ProjectManagerBoardResult } from "@termloop/contract/current";

import type { Task } from "../model.js";
import { Icon } from "./Icon.js";
import { relativeTime } from "./project-manager-ticket.js";
import { jiraIssueKey } from "./ProjectManagerWorkspace.js";

export const RISK_LABELS: Record<DeliveryRiskKind, string> = {
  blocked: "Blocked",
  readFailed: "Read failed",
  reviewStalled: "Review stalled",
  checksFailing: "Checks fail",
  mergedNotDeployed: "Merged, not deployed",
  notInProduction: "Not in production",
  jiraBehind: "Jira behind",
  jiraAhead: "Jira ahead",
};

export type ProjectManagerDigest = {
  sprintName: string | null;
  tasks: number;
  inReview: number;
  merged: number;
  inProduction: number;
  atRisk: { task: Task; risks: DeliveryRiskDto[] }[];
};

/// The active sprint at a glance, counted from the board's facts and risks.
/// Without an active sprint, every open Task counts.
export function projectManagerDigest(tasks: readonly Task[], board: ProjectManagerBoardResult | null): ProjectManagerDigest {
  const active = board?.sprints.find((sprint) => sprint.state === "active");
  const sprintOf = new Map((board?.tracking ?? []).map((record) => [record.taskId, record.sprintId]));
  const scoped = tasks
    .filter((task) => task.status === "open" && task.archived_at_epoch_ms === null)
    .filter((task) => !active || sprintOf.get(task.id) === active.id)
    .slice()
    .sort((left, right) => left.rank - right.rank);
  const facts = new Map((board?.facts ?? []).map((record) => [record.taskId, record]));
  const count = (test: (taskId: string) => boolean) => scoped.filter((task) => test(task.id)).length;
  const pullRequests = (taskId: string) => facts.get(taskId)?.pullRequests?.items ?? [];
  return {
    sprintName: active?.name ?? null,
    tasks: scoped.length,
    inReview: count((taskId) => pullRequests(taskId).some((item) => item.state === "open" || item.state === "draft")),
    merged: count((taskId) => pullRequests(taskId).some((item) => item.state === "merged")),
    inProduction: count((taskId) => (facts.get(taskId)?.environments ?? [])
      .some((environment) => /prod/iu.test(environment.name) && environment.state === "deployed")),
    atRisk: scoped
      .map((task) => ({ task, risks: (board?.risks ?? []).filter((risk) => risk.taskId === task.id) }))
      .filter((entry) => entry.risks.length > 0),
  };
}

/// What the Project Manager sees before choosing a Task: the active sprint's
/// delivery counts and the Tasks that need attention.
export function ProjectManagerOverview(props: {
  tasks: readonly Task[];
  board: ProjectManagerBoardResult | null;
  disabled: boolean;
  select(taskId: string): void;
  checkSprint(): void;
  addTask(): void;
}) {
  const digest = projectManagerDigest(props.tasks, props.board);
  const stats: [string, number][] = [
    ["Tasks", digest.tasks],
    ["In review", digest.inReview],
    ["Merged", digest.merged],
    ["In production", digest.inProduction],
    ["Need attention", digest.atRisk.length],
  ];
  return <div className="pm-overview" aria-label="Sprint overview">
    <header className="pm-overview-head">
      <div>
        <span className="pm-eyebrow">{digest.sprintName ? "Active sprint" : "No active sprint"}</span>
        <h2>{digest.sprintName ?? "Open Tasks"}</h2>
      </div>
      <div className="pm-overview-actions">
        <button type="button" className="secondary-button" disabled={props.disabled || digest.tasks === 0} onClick={props.checkSprint}>
          <Icon name="restart" />Check sprint
        </button>
        <button type="button" className="primary-button" onClick={props.addTask}>Add Task</button>
      </div>
    </header>
    <dl className="pm-overview-stats">
      {stats.map(([label, value]) => <div key={label} className="pm-overview-stat">
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>)}
    </dl>
    <section className="pm-overview-risks" aria-label="Needs attention">
      <h3>Needs attention</h3>
      {digest.atRisk.length === 0
        ? <p className="pm-muted">{digest.tasks === 0 ? "No Tasks to watch yet." : "Nothing stands out. TermLoop keeps reading Jira and pull requests."}</p>
        : <ul>
          {digest.atRisk.map(({ task, risks }) => <li key={task.id}>
            <button type="button" onClick={() => props.select(task.id)}>
              <span className="pm-task-key">{jiraIssueKey(task.jira_url) ?? "Local"}</span>
              <strong>{task.title}</strong>
              <span className="pm-overview-risk-list">
                {risks.map((risk, index) => <span key={index} className={`pm-risk ${risk.kind}`} title={risk.sinceEpochMs ? `Since ${relativeTime(risk.sinceEpochMs)}` : undefined}>
                  <b>{RISK_LABELS[risk.kind]}</b> {risk.detail}
                </span>)}
              </span>
            </button>
          </li>)}
        </ul>}
    </section>
  </div>;
}
