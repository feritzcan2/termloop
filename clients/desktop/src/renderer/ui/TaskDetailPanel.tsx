import { useMemo } from "react";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import type { AgentStatus, BranchCommitSummary, GitHostProjection, Session, Task } from "../model.js";
import { sessionLabel, taskEffectiveBranch } from "../model.js";
import { agentAttention, sessionState } from "../session-presentation.js";
import {
  integrationTone, taskChangeCount, taskChangedFileLabel, taskDivergence, taskIntegration, taskStage,
} from "../task-presentation.js";
import { GitHostPullRequests, TaskMetaLine } from "./TaskRail.js";
import { TaskBrief } from "./TaskBrief.js";
import { Icon, agentIconName } from "./Icon.js";
import { pullRequestIdentity, type ChangesOpenSource } from "../change-source.js";

export type TaskDetailPanelProps = {
  task: Task;
  sessions: readonly Session[];
  statusesById: ReadonlyMap<string, AgentStatus>;
  reviewReadySessionIds: ReadonlySet<string>;
  gitHostProjection: GitHostProjection | undefined;
  branchCommitSummary: BranchCommitSummary | undefined;
  close(): void;
  selectSession(sessionId: string): void;
  openFiles?(): void;
  openChanges(source: ChangesOpenSource): void;
  openExternal(url: string, runSessionId?: string): Promise<void>;
  /** Launchers are optional: a host without them (tests, a read-only stage)
      simply shows no Start row. */
  agentCapabilities?: readonly AgentCapabilityDto[] | undefined;
  launchTerminal?: ((taskId: string) => Promise<unknown>) | undefined;
  launchAgent?: ((taskId: string, agentId: string) => Promise<unknown>) | undefined;
};

type AttentionItem = { tone: string; text: string; detail?: string | undefined; act?: { label: string; run(): void } };

export function TaskDetailPanel(props: TaskDetailPanelProps) {
  const { task } = props;
  const stage = taskStage(task, false);
  const divergence = taskDivergence(task);
  const effectiveBranch = taskEffectiveBranch(task);
  const changeCount = taskChangeCount(task);
  const integration = taskIntegration(props.gitHostProjection, props.branchCommitSummary);
  const commitCount = props.branchCommitSummary?.freshness === "fresh"
    ? props.branchCommitSummary.count
    : null;
  const description = task.brief?.trim() ?? "";
  const stewardBrief = task.steward_brief_markdown?.trim() ?? "";
  const attention = useMemo(
    () => agentAttention(props.sessions, props.statusesById, props.reviewReadySessionIds),
    [props.sessions, props.statusesById, props.reviewReadySessionIds],
  );
  const launchers = (props.agentCapabilities ?? []).filter((capability) => capability.available);
  const canLaunch = stage.id === "ready" && Boolean(props.launchTerminal || props.launchAgent);

  const hasPullRequests = (props.gitHostProjection?.matches.length ?? 0) > 0;
  const openPullRequest = (pullRequest: GitHostProjection["matches"][number]) => props.openChanges({
    kind: "pullRequest",
    pullRequest: pullRequestIdentity(pullRequest),
    freshnessGeneration: props.gitHostProjection?.freshness_generation ?? 0,
  });
  /// The header meta line is the sidebar card's, one to one, so the two
  /// surfaces name the same facts in the same words and colours.
  const branchChanges = commitCount
    ? {
        label: `${commitCount} ${commitCount === 1 ? "commit" : "commits"}`,
        title: `Review the combined changes from ${commitCount} ${commitCount === 1 ? "commit" : "commits"} on this Task branch since its base.`,
        ariaLabel: `Review all branch changes in ${task.title}`,
        open: () => props.openChanges({ kind: "commits" }),
      }
    : undefined;
  const openIntegration = integration?.action === "pullRequest" && integration.pullRequest
    ? () => openPullRequest(integration.pullRequest!)
    : integration?.action === "commits"
      ? () => props.openChanges({ kind: "commits" })
      : undefined;
  /// Banners exist only when something is actually asking for the reader: an
  /// agent waiting on them, a checkout that is not healthy, or a diverged
  /// branch. A healthy, quiet Task prints no reassurance line at all.
  const banners: AttentionItem[] = [];
  if (attention && attention.tone !== "working") {
    banners.push({
      tone: attention.tone,
      text: `${attention.agent} — ${attention.label}`,
      act: { label: "Open terminal", run: () => props.selectSession(attention.sessionId) },
    });
  }
  if (stage.tone !== "quiet") banners.push({ tone: stage.tone, text: stage.flag ?? stage.summary, detail: stage.flag ? stage.summary : undefined });
  if (divergence) banners.push({ tone: "attention", text: divergence.text, detail: divergence.title });
  const otherBranches = task.branches?.items.filter((branch) => branch.branch_id !== "primary") ?? [];

  return (
    <section className="task-detail" aria-label={`Task ${task.title}`}>
      <header className="td-header">
        <div className="td-heading">
          <div className="td-title-row">
            <h1 title={task.title}>{task.title}</h1>
            {task.status === "closed" ? <span className="td-status closed">Closed</span> : null}
          </div>
          <TaskMetaLine
            task={task}
            stage={stage}
            divergence={divergence}
            changeCount={changeCount}
            branchChanges={branchChanges}
            integration={integration}
            openChanges={() => props.openChanges({ kind: "local" })}
            openIntegration={openIntegration}
            openIssue={() => { if (task.jira_url) void props.openExternal(task.jira_url); }}
          />
        </div>
        <div className="td-header-actions">
          <button
            type="button"
            className="ap-close"
            aria-label="Back to the terminal"
            title="Back to the terminal"
            onClick={props.close}
          ><Icon name="close" /></button>
        </div>
      </header>
      <div className="td-body">
        {banners.length > 0 ? (
          <ul className="td-now-list" aria-label="Needs attention">
            {banners.map((item, index) => (
              <li key={index} className={`td-now-item ${item.tone}`} title={item.detail}>
                <i className="td-fact-dot" aria-hidden="true" />
                <span className="td-now-text">{item.text}</span>
                {item.act ? <button type="button" className="td-mini" onClick={item.act.run}>{item.act.label}</button> : null}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="td-layout">
          <aside className="td-side">
            <section className="td-card" aria-label="Sessions">
              <div className="td-card-head">
                <h2>Sessions</h2>
                {props.sessions.length > 0 ? <span className="td-count">{props.sessions.length}</span> : null}
              </div>
              {props.sessions.length === 0
                ? <p className="td-note">No Session is running in this Task.</p>
                : <ul className="td-agents">
                  {props.sessions.map((session) => {
                    const state = sessionState(session, props.statusesById.get(session.id), props.reviewReadySessionIds.has(session.id));
                    return (
                      <li key={session.id}>
                        <button
                          type="button"
                          className="td-agent"
                          title={`${sessionLabel(session)} — ${state.summary} Opens its terminal.`}
                          onClick={() => props.selectSession(session.id)}
                        >
                          <i className={`td-agent-dot ${state.tone}`} aria-hidden="true" />
                          <span className="td-agent-name">{sessionLabel(session)}</span>
                          {state.label ? <span className="td-agent-state">{state.label}</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>}
              {canLaunch ? (
                <div className="td-launch" role="group" aria-label={`Start a new Session in ${task.title}`}>
                  {props.launchTerminal ? <button type="button" className="td-mini" onClick={() => void props.launchTerminal!(task.id)}><Icon name="terminal" />Terminal</button> : null}
                  {props.launchAgent ? launchers.map((capability) => (
                    <button
                      key={capability.agent_id}
                      type="button"
                      className={`td-mini agent-${capability.agent_id}`}
                      title={`New ${capability.label} Session${capability.integration_level === "launchOnly" ? " (launch only)" : ""}`}
                      onClick={() => void props.launchAgent!(task.id, capability.agent_id)}
                    ><Icon name={agentIconName(capability.agent_id)} />{capability.label}</button>
                  )) : null}
                </div>
              ) : null}
            </section>

            <section className="td-card" aria-label="Changes">
              <div className="td-card-head"><h2>Changes</h2></div>
              <div className="td-facts">
                <span
                  className={`td-fact td-effective-branch${divergence ? " attention" : ""}`}
                  title={divergence?.title ?? (effectiveBranch
                    ? `Current effective branch: ${effectiveBranch}`
                    : "No branch is currently available for this Task")}
                >
                  <Icon name="branch" />
                  <span>{effectiveBranch ?? "No branch"}</span>
                </span>
                <button
                  type="button"
                  className="td-fact-action"
                  disabled={!task.worktree}
                  title={task.worktree ? "Open the changed files in this worktree" : "This Task has no worktree yet"}
                  onClick={() => props.openChanges({ kind: "local" })}
                >
                  <Icon name="edit" />
                  <span>{changeCount ? taskChangedFileLabel(changeCount) : "No uncommitted changes"}</span>
                </button>
                {commitCount ? (
                  <button
                    type="button"
                    className="td-fact-action"
                    title="Open the commits on this Task branch"
                    onClick={() => props.openChanges({ kind: "commits" })}
                  >
                    <Icon name="branch" />
                    <span>{commitCount} {commitCount === 1 ? "commit" : "commits"} on this branch</span>
                  </button>
                ) : null}
                {props.openFiles ? <button type="button" className="td-fact-action" disabled={!task.worktree} onClick={props.openFiles} title="Browse all files in this Task worktree"><Icon name="folder" /><span>Browse files</span></button> : null}
                {integration && !hasPullRequests ? (
                  <span className={`td-fact ${integrationTone(integration, Boolean(changeCount))}`} title={integration.title}>
                    <i className="td-fact-dot" aria-hidden="true" />{integration.label}
                  </span>
                ) : null}
              </div>
              {otherBranches.length > 0 || task.branches?.evidence_truncated ? (
                <div className="td-subsection">
                  <h3>Other branches</h3>
                  <div className="td-facts">
                    {otherBranches.map((branch) => {
                      const base = branch.base_ref;
                      const warning = branch.role === "baseBranch"
                        ? "This Task's base branch was checked out in the worktree; it is not included in Task commit rollups."
                        : branch.role === "heldByOtherTask"
                          ? `This branch is the primary branch of another Task${branch.held_by_task_id ? ` (${branch.held_by_task_id})` : ""}; it is not included in Task commit rollups.`
                          : `Observed in this Task worktree${base ? ` with activity base ${base}` : ""}.`;
                      return (
                        <button
                          key={branch.branch_id}
                          type="button"
                          className={`td-fact-action${branch.checked_out ? " active" : ""}`}
                          title={`${warning} Open commits on ${branch.name}.`}
                          onClick={() => props.openChanges({ kind: "commits", branchId: branch.branch_id })}
                        >
                          <Icon name="branch" />
                          <span>{branch.name}{base ? ` · base ${base}` : ""}</span>
                        </button>
                      );
                    })}
                    {task.branches?.evidence_truncated ? (
                      <span className="td-fact attention" title="The exact worktree reflog was missing, expired, or exceeded its bounded observation window. The branch list may be incomplete.">
                        <i className="td-fact-dot" aria-hidden="true" />Branch history may be incomplete
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {hasPullRequests ? (
                <div className="td-subsection">
                  <h3>Pull requests</h3>
                  <GitHostPullRequests
                    projection={props.gitHostProjection}
                    openChanges={openPullRequest}
                    openExternal={props.openExternal}
                  />
                </div>
              ) : null}
            </section>
          </aside>

          <div className="td-main">
            <section className="td-card td-description" aria-label="Description">
              <div className="td-card-head"><h2>Description</h2></div>
              {description
                ? <TaskBrief brief={description} format={task.jira_url ? "jiraWiki" : "plain"} />
                : <p className="td-note">This Task has no description.</p>}
            </section>
            {stewardBrief ? (
              <details className="td-card td-steward">
                <summary><h2>Steward brief</h2></summary>
                <p className="td-prose mono">{stewardBrief}</p>
              </details>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
