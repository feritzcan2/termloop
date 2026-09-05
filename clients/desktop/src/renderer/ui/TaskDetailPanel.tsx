import { useMemo } from "react";
import type {
  PlaybookDto, PlaybookMilestoneDto, PlaybookRuntimeResult,
  PlaybookStepProgressDto, PlaybookTaskPositionSetResult,
} from "@termloop/contract/current";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import type { AgentStatus, BranchCommitSummary, GitHostProjection, Session, Task } from "../model.js";
import { sessionLabel, taskEffectiveBranch, taskJiraIssueKey } from "../model.js";
import { agentAttention, sessionState } from "../session-presentation.js";
import {
  integrationTone, taskChangeCount, taskChangedFileLabel, taskDivergence, taskIntegration, taskStage,
} from "../task-presentation.js";
import { playbookRelativeMinutes } from "./playbook-policy.js";
import { GitHostPullRequests, TaskMetaLine } from "./TaskRail.js";
import { TaskBrief } from "./TaskBrief.js";
import { Icon } from "./Icon.js";
import { pullRequestIdentity, type ChangesOpenSource } from "../change-source.js";
import { PROJECT_CONTROL_PHASES, deriveProjectControlTask } from "../project-control.js";

/* ------------------------------------------------------------- derivation */

/** Where this one Task stands at one pipeline stage. */
export type TaskStepStanding = "passed" | "waiting" | "ahead";

/** Where the Task stands on the pipeline as a whole. `away` covers a Task the
    pipeline does not walk at all — closed or archived — which core leaves out
    of both the waiting lists and the done list rather than inventing a rung
    for it. */
export type TaskPipelinePlacement = "waiting" | "done" | "away";

export type TaskStepRoutine = { name: string; enabled: boolean };

export type TaskPipelineStep = {
  /** 1-based, because the pipeline is a real sequence and the reader counts
      stages rather than array slots. */
  position: number;
  milestone: PlaybookMilestoneDto;
  standing: TaskStepStanding;
  /** This Task's own recorded answer at this step, when one exists. */
  progress: PlaybookStepProgressDto | undefined;
  routine: TaskStepRoutine | undefined;
};

export type TaskPipelineView = {
  pipelineName: string;
  steps: readonly TaskPipelineStep[];
  placement: TaskPipelinePlacement;
  /** 1-based position of the stage this Task is waiting at right now. */
  standingAt: number | undefined;
  passedCount: number;
};

function stepStanding(
  placement: TaskPipelinePlacement,
  waitingIndex: number,
  index: number,
  progress: PlaybookStepProgressDto | undefined,
): TaskStepStanding {
  // Core's own rule: a Task stands at the first stage it has not passed, so
  // everything before that rung is cleared by definition. A Task the pipeline
  // no longer walks has no rung, and only its recorded answers can speak.
  if (placement === "waiting") {
    if (index < waitingIndex) return "passed";
    return index === waitingIndex ? "waiting" : "ahead";
  }
  return progress?.verdict === "passed" ? "passed" : "ahead";
}

/** One Task's journey through the pipeline the Project is walking. Returns
    nothing when there is no pipeline to walk — the caller says so in words
    rather than drawing an empty ladder. */
export function taskPipelineView(
  playbook: PlaybookDto | null,
  runtime: PlaybookRuntimeResult | null,
  routines: readonly (TaskStepRoutine & { id: string })[],
  taskId: string,
): TaskPipelineView | undefined {
  if (!playbook || playbook.milestones.length === 0) return undefined;
  const byMilestone = new Map((runtime?.steps ?? []).map((step) => [step.milestoneId, step]));
  const waitingIndex = playbook.milestones.findIndex(
    (milestone) => byMilestone.get(milestone.id)?.waitingTaskIds.includes(taskId) ?? false,
  );
  const placement: TaskPipelinePlacement = waitingIndex >= 0
    ? "waiting"
    : runtime?.doneTaskIds.includes(taskId) ? "done" : "away";
  const steps = playbook.milestones.map((milestone, index) => {
    const progress = byMilestone.get(milestone.id)?.progress.find((entry) => entry.taskId === taskId);
    const routine = routines.find((candidate) => candidate.id === milestone.routineId);
    return {
      position: index + 1,
      milestone,
      standing: stepStanding(placement, waitingIndex, index, progress),
      progress,
      routine: routine ? { name: routine.name, enabled: routine.enabled } : undefined,
    };
  });
  return {
    pipelineName: playbook.activePipelineName,
    steps,
    placement,
    standingAt: waitingIndex >= 0 ? waitingIndex + 1 : undefined,
    passedCount: steps.filter((step) => step.standing === "passed").length,
  };
}

/** The one line above the ladder: how far along this Task is. */
export function pipelineProgressLabel(view: TaskPipelineView): string {
  const total = view.steps.length;
  if (view.placement === "done") return `Cleared all ${total}`;
  if (view.placement === "away") return `${view.passedCount} of ${total} cleared`;
  return `Step ${view.standingAt} of ${total}`;
}

/** When this step last moved, or when it is evaluated again. Passed steps look
    backwards; the standing step looks forwards, because the only thing left to
    know about it is when it gets asked next. */
export function stepTiming(step: TaskPipelineStep, nowEpochMs: number): string | undefined {
  const progress = step.progress;
  if (step.standing === "passed") {
    return progress
      ? `cleared ${playbookRelativeMinutes(Math.max(0, nowEpochMs - progress.decidedAtEpochMs))} ago`
      : undefined;
  }
  if (step.standing !== "waiting") return undefined;
  const due = progress?.nextAttemptAtEpochMs ?? null;
  if (due === null || due <= nowEpochMs) return "checking next";
  return `next check in ${playbookRelativeMinutes(due - nowEpochMs)}`;
}

/** What this Task's record says at this step, in the Routine's own words. A
    step nobody has evaluated yet says so rather than showing an empty line. */
export function stepEvidence(step: TaskPipelineStep): string | undefined {
  const evidence = step.progress?.evidence.trim();
  if (evidence) return evidence;
  if (step.standing === "waiting") return "No completion result recorded for this Task yet.";
  return undefined;
}

export type TaskStepAnswerSource = { text: string; blocked: boolean };

export type PlaybookTaskPositionSetOutcome =
  | { ok: true; result: PlaybookTaskPositionSetResult }
  | { ok: false; code: string | undefined; message: string };

/** Who evaluates this step — and whether anybody can. A step whose Routine
    is missing or switched off will never move on its own, and that is the one
    fact the reader has to act on. */
export function stepAnswerSource(step: TaskPipelineStep): TaskStepAnswerSource {
  if (step.milestone.gate === "human") {
    return step.milestone.approver
      ? { text: `${step.milestone.approver} approves this`, blocked: false }
      : { text: "No approver named", blocked: true };
  }
  if (!step.routine) return { text: "No completion Routine", blocked: true };
  return step.routine.enabled
    ? { text: step.routine.name, blocked: false }
    : { text: `${step.routine.name} is off`, blocked: true };
}

/** Running a step Routine by hand is only meaningful for the automatic stage
    this Task is standing at. A human gate waits on a person. */
export function stepIsCheckable(step: TaskPipelineStep): boolean {
  return step.standing === "waiting"
    && step.milestone.gate === "automatic"
    && step.routine !== undefined
    && step.routine.enabled;
}

/* -------------------------------------------------------------- component */

export type TaskDetailPanelProps = {
  task: Task;
  /** Bumped by the daemon's own playbook/routine invalidation, so the ladder
      follows Worker verdicts without this page polling for them. */
  refreshToken: number;
  sessions: readonly Session[];
  statusesById: ReadonlyMap<string, AgentStatus>;
  reviewReadySessionIds: ReadonlySet<string>;
  gitHostProjection: GitHostProjection | undefined;
  branchCommitSummary: BranchCommitSummary | undefined;
  /** Injected by tests so the countdown is not read off the wall clock. */
  nowEpochMs?: number | undefined;
  close(): void;
  selectSession(sessionId: string): void;
  openChanges(source: ChangesOpenSource): void;
  openExternal(url: string, runSessionId?: string): Promise<void>;
  /** Launchers are optional: a host without them (tests, a read-only stage)
      simply shows no Start row. */
  agentCapabilities?: readonly AgentCapabilityDto[] | undefined;
  launchTerminal?: ((taskId: string) => Promise<unknown>) | undefined;
  launchAgent?: ((taskId: string, agentId: string) => Promise<unknown>) | undefined;
};

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
  const control = useMemo(() => deriveProjectControlTask({
    task,
    gitHostProjection: props.gitHostProjection,
    branchCommitSummary: props.branchCommitSummary,
    sessions: props.sessions,
    statusesById: props.statusesById,
  }), [props.branchCommitSummary, props.gitHostProjection, props.sessions, props.statusesById, task]);
  const attention = useMemo(
    () => agentAttention(props.sessions, props.statusesById, props.reviewReadySessionIds),
    [props.sessions, props.statusesById, props.reviewReadySessionIds],
  );
  const launchers = (props.agentCapabilities ?? []).filter((capability) => capability.available);
  const canLaunch = stage.id === "ready" && (props.launchTerminal || props.launchAgent);

  const firstPullRequest = props.gitHostProjection?.matches[0];
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
  /// "Now" exists only when something is actually asking for the reader: an
  /// agent waiting on them, a checkout that is not healthy, or a diverged
  /// branch. A healthy, quiet Task prints no reassurance line at all.
  const now: { tone: string; text: string; detail?: string | undefined; act?: { label: string; run(): void } }[] = [];
  if (attention && attention.tone !== "working") {
    now.push({
      tone: attention.tone,
      text: `${attention.agent} — ${attention.label}`,
      act: { label: "Open terminal", run: () => props.selectSession(attention.sessionId) },
    });
  }
  if (stage.tone !== "quiet") now.push({ tone: stage.tone, text: stage.flag ?? stage.summary, detail: stage.flag ? stage.summary : undefined });
  if (divergence) now.push({ tone: "attention", text: divergence.text, detail: divergence.title });

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
        <button
          type="button"
          className="ap-close"
          aria-label="Back to the terminal"
          title="Back to the terminal"
          onClick={props.close}
        ><Icon name="close" /></button>
      </header>
      <div className="td-body">
        {task.brief?.trim() ? (
          <TaskBrief brief={task.brief} format={task.jira_url ? "jiraWiki" : "plain"} />
        ) : null}
        {now.length > 0 ? (
          <section className="td-block td-now" aria-label="Needs attention">
            <h2>Now</h2>
            <ul className="td-now-list">
              {now.map((item, index) => (
                <li key={index} className={`td-now-item ${item.tone}`} title={item.detail}>
                  <i className="td-fact-dot" aria-hidden="true" />
                  <span className="td-now-text">{item.text}</span>
                  {item.act ? <button type="button" className="td-mini" onClick={item.act.run}>{item.act.label}</button> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="td-block" aria-label="Sessions">
          <div className="td-block-head">
            <h2>Sessions</h2>
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
                  ><Icon name={capability.agent_id === "claude" ? "claude" : capability.agent_id === "codex" ? "codex" : "agent"} />{capability.label}</button>
                )) : null}
              </div>
            ) : null}
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
        </section>

        <section className="td-block" aria-label="Changes">
          <h2>Changes</h2>
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
            {task.branches?.items
              .filter((branch) => branch.branch_id !== "primary")
              .map((branch) => {
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
            {integration && !firstPullRequest ? (
              <span className={`td-fact ${integrationTone(integration, Boolean(changeCount))}`} title={integration.title}>
                <i className="td-fact-dot" aria-hidden="true" />{integration.label}
              </span>
            ) : null}
          </div>
          <GitHostPullRequests
            projection={props.gitHostProjection}
            openChanges={openPullRequest}
            openExternal={props.openExternal}
          />
        </section>

        <section className="td-block td-control" aria-label="Project Control">
          <div className="td-block-head">
            <h2>Status</h2>
            <span className={`td-control-phase phase-${control.phase}`}>{control.phaseLabel}</span>
          </div>
          <p className="td-note">Updates automatically from the worktree, Agent, commits, and pull request. Nothing runs in the background.</p>
          <ol className="td-control-spine">
            {PROJECT_CONTROL_PHASES.map((phase) => {
              const currentIndex = PROJECT_CONTROL_PHASES.findIndex((candidate) => candidate.id === control.phase);
              const phaseIndex = PROJECT_CONTROL_PHASES.findIndex((candidate) => candidate.id === phase.id);
              const state = phase.id === control.phase ? "current" : phaseIndex < currentIndex ? "passed" : "ahead";
              return <li key={phase.id} className={state} aria-current={state === "current" ? "step" : undefined}>
                <i aria-hidden="true" />
                <span>{phase.label}</span>
              </li>;
            })}
          </ol>
          <dl className="td-control-facts">
            {control.facts.map((fact) => <div key={fact.id} className={fact.tone} title={fact.detail}>
              <dt>{fact.label}</dt><dd>{fact.value}</dd>
            </div>)}
          </dl>
        </section>
      </div>
    </section>
  );
}

function PipelineStep({ step, nowEpochMs, running, settingPosition, controlsBusy, canSetPosition, checkNow, setPosition }: {
  step: TaskPipelineStep;
  nowEpochMs: number;
  running: boolean;
  settingPosition: number | undefined;
  controlsBusy: boolean;
  canSetPosition: boolean;
  checkNow(routineId: string): Promise<void>;
  setPosition(passedMilestoneCount: number): Promise<void>;
}) {
  const timing = stepTiming(step, nowEpochMs);
  const evidence = stepEvidence(step);
  const answers = stepAnswerSource(step);
  const checkable = stepIsCheckable(step);
  return (
    <li
      className={`td-step ${step.standing}${step.milestone.gate === "human" ? " human" : ""}`}
      aria-current={step.standing === "waiting" ? "step" : undefined}
      title={step.standing !== "waiting" ? evidence : undefined}
    >
      <span className="td-node" aria-hidden="true">{step.position}</span>
      <div className="td-step-body">
        <div className="td-step-title-row">
          <p className="td-step-title">{step.milestone.title}</p>
          {step.milestone.gate === "human" ? <span className="td-gate">Approval</span> : null}
          {canSetPosition ? (
            <button
              type="button"
              className="td-set-position"
              disabled={controlsBusy}
              aria-label={`Set Task at delivery pipeline step ${step.position}`}
              onClick={() => void setPosition(step.position - 1)}
            >{settingPosition === step.position - 1
              ? "Setting…"
              : step.position === 1
                ? "Reset to start"
                : step.standing === "waiting" ? "Reset here" : "Set here"}</button>
          ) : null}
        </div>
        {step.standing === "waiting" ? (
          <>
            <p className="td-evidence">{evidence}</p>
            <div className="td-step-foot">
              <span className={`td-answers${answers.blocked ? " blocked" : ""}`}>
                {answers.blocked || step.milestone.gate === "human" ? answers.text : `Checked by ${answers.text}`}
              </span>
              {timing ? <span className="td-timing">{timing}</span> : null}
              {checkable && step.milestone.routineId ? (
                <button
                  type="button"
                  className="td-check-now"
                  disabled={controlsBusy || running}
                  title={running
                    ? `${answers.text} is checking this step now`
                    : `Run ${answers.text} now instead of waiting`}
                  onClick={() => void checkNow(step.milestone.routineId)}
                >{running ? "Checking…" : "Check now"}</button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            {/* Cleared stages keep their whole sentence: the answer a Routine
                recorded is the only reason to look back at a stage at all, and
                a trimmed one sends the reader hunting for a tooltip. */}
            {/* Off the standing rung, the recorded answer folds into the row's
                tooltip: the page is about the question being asked now, and a
                cleared stage earns one line, not a paragraph. */}
            <div className="td-step-foot" title={evidence}>
              {/* A stage still ahead is worth naming its judge for: a Routine
                  that is missing or switched off will never move this Task, and
                  seeing that now beats discovering it on arrival. */}
              {step.standing === "ahead"
                ? <span className={`td-answers${answers.blocked ? " blocked" : ""}`}>{answers.text}</span>
                : null}
              {timing ? <span className="td-timing">{timing}</span> : null}
            </div>
          </>
        )}
      </div>
    </li>
  );
}
