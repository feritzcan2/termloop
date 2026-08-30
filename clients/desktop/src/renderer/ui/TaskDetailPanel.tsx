import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PlaybookDto, PlaybookMilestoneDto, PlaybookGetResult, PlaybookRuntimeResult,
  PlaybookStepProgressDto, PlaybookTaskPositionSetParams, PlaybookTaskPositionSetResult,
  RoutineConfigurationListResult, RoutineRunNowResult, RoutineRuntimeListResult,
} from "@termloop/contract/current";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import type { AgentStatus, BranchCommitSummary, GitHostProjection, Session, Task } from "../model.js";
import { sessionLabel, taskJiraIssueKey } from "../model.js";
import { agentAttention, sessionState } from "../session-presentation.js";
import {
  integrationTone, taskChangeCount, taskChangedFileLabel, taskDivergence, taskIntegration, taskStage,
} from "../task-presentation.js";
import { playbookRelativeMinutes } from "./playbook-policy.js";
import { GitHostPullRequests, TaskMetaLine } from "./TaskRail.js";
import { Icon } from "./Icon.js";
import { pullRequestIdentity, type ChangesOpenSource } from "../change-source.js";

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
  openPlaybook(): void;
  getPlaybook(): Promise<PlaybookGetResult>;
  getPlaybookRuntime(): Promise<PlaybookRuntimeResult>;
  setPlaybookTaskPosition(params: PlaybookTaskPositionSetParams): Promise<PlaybookTaskPositionSetOutcome>;
  listRoutines(): Promise<RoutineConfigurationListResult>;
  listRoutineRuntime(): Promise<RoutineRuntimeListResult>;
  runRoutineNow(routineId: string, taskId?: string): Promise<RoutineRunNowResult>;
  /** Launchers are optional: a host without them (tests, a read-only stage)
      simply shows no Start row. */
  agentCapabilities?: readonly AgentCapabilityDto[] | undefined;
  launchTerminal?: ((taskId: string) => Promise<unknown>) | undefined;
  launchAgent?: ((taskId: string, agentId: string) => Promise<unknown>) | undefined;
};

export function TaskDetailPanel(props: TaskDetailPanelProps) {
  const { task } = props;
  const [playbook, setPlaybook] = useState<PlaybookDto | null>(null);
  const [runtime, setRuntime] = useState<PlaybookRuntimeResult | null>(null);
  const [routines, setRoutines] = useState<readonly (TaskStepRoutine & { id: string })[]>([]);
  const [checkingRoutineIds, setCheckingRoutineIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState<string>();
  const [settingPosition, setSettingPosition] = useState<number>();
  const [stateRevision, setStateRevision] = useState(0);
  const [clockNowEpochMs, setClockNowEpochMs] = useState(Date.now);
  const nowEpochMs = props.nowEpochMs ?? clockNowEpochMs;

  // The composition layer rebuilds these reads on every one of its renders, so
  // depending on their identities would refetch the whole page each time an
  // unrelated projection moved. The page reloads when its own Task changes or
  // when the daemon says the playbook did — and always through the newest
  // functions, which the ref holds.
  const readsRef = useRef(props);
  readsRef.current = props;
  // Rounds overlap whenever the daemon answers slower than the projection
  // moves, and their answers can arrive out of order. Only the newest round may
  // write state.
  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    const { getPlaybook, getPlaybookRuntime, listRoutines, listRoutineRuntime } = readsRef.current;
    const generation = ++loadGeneration.current;
    try {
      const [playbookResult, runtimeResult, routineResult, routineRuntimeResult] = await Promise.all([
        getPlaybook(), getPlaybookRuntime(), listRoutines(), listRoutineRuntime(),
      ]);
      if (generation !== loadGeneration.current) return;
      setPlaybook(playbookResult.playbook);
      setRuntime(runtimeResult);
      setStateRevision(Math.max(
        playbookResult.stateRevision,
        runtimeResult.stateRevision,
        routineResult.stateRevision,
        routineRuntimeResult.stateRevision,
      ));
      setRoutines(routineResult.configurations.map(
        (routine) => ({ id: routine.id, name: routine.name, enabled: routine.enabled }),
      ));
      setCheckingRoutineIds(new Set(
        routineRuntimeResult.health
          .filter((health) => health.state === "checking")
          .map((health) => health.routineId),
      ));
      setError(undefined);
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load, task.id, props.refreshToken]);

  const view = useMemo(
    () => taskPipelineView(playbook, runtime, routines, task.id),
    [playbook, runtime, routines, task.id],
  );
  // Only a live countdown needs a clock, and only while one is actually shown.
  const counting = view?.placement === "waiting";
  useEffect(() => {
    if (props.nowEpochMs !== undefined || !counting) return;
    const handle = window.setInterval(() => setClockNowEpochMs(Date.now()), 30_000);
    return () => window.clearInterval(handle);
  }, [counting, props.nowEpochMs]);

  const checkNow = useCallback(async (routineId: string) => {
    setRunning(routineId);
    try {
      await readsRef.current.runRoutineNow(routineId, task.id);
      setError(undefined);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(undefined);
    }
  }, [load, task.id]);

  const setPosition = useCallback(async (passedMilestoneCount: number) => {
    const currentPlaybook = playbook;
    if (!currentPlaybook) return;
    setSettingPosition(passedMilestoneCount);
    try {
      const outcome = await readsRef.current.setPlaybookTaskPosition({
        projectId: task.project_id,
        taskId: task.id,
        passedMilestoneCount,
        expectedPlaybookRevision: currentPlaybook.revision,
        expectedRevision: stateRevision,
      });
      if (!outcome.ok) {
        if (outcome.code === "conflict") {
          await load();
          setError("The pipeline changed while this page was open. It is refreshed; choose the level again.");
        } else {
          setError(outcome.message);
        }
        return;
      }
      setStateRevision(outcome.result.stateRevision);
      setError(undefined);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingPosition(undefined);
    }
  }, [load, playbook, stateRevision, task.id, task.project_id]);

  const stage = taskStage(task, false);
  const divergence = taskDivergence(task);
  const changeCount = taskChangeCount(task);
  const integration = taskIntegration(props.gitHostProjection, props.branchCommitSummary);
  const commitCount = props.branchCommitSummary?.freshness === "fresh"
    ? props.branchCommitSummary.count
    : null;
  const brief = task.steward_brief_markdown?.trim() ?? "";
  const attention = useMemo(
    () => agentAttention(props.sessions, props.statusesById, props.reviewReadySessionIds),
    [props.sessions, props.statusesById, props.reviewReadySessionIds],
  );
  const launchers = (props.agentCapabilities ?? []).filter((capability) => capability.available);
  const canLaunch = stage.id === "ready" && (props.launchTerminal || props.launchAgent);

  const cleared = view ? (view.placement === "done" ? view.steps.length : view.passedCount) : 0;
  const clearedPercent = view && view.steps.length > 0
    ? Math.round((cleared / view.steps.length) * 100)
    : 0;
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
          {task.brief?.trim() ? <p className="td-brief">{task.brief}</p> : null}
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
      {error ? <p className="ap-error" role="alert">{error}</p> : null}
      <div className="td-body">
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

        <section className="td-block td-pipeline" aria-label="Delivery pipeline">
          <div className="td-block-head">
            <h2>Pipeline</h2>
            {view ? <span className="td-progress">{view.pipelineName} · {pipelineProgressLabel(view)}</span> : null}
          </div>
          {loading && !view ? <p className="td-note">Reading the pipeline…</p>
            : view ? <>
              <div className={`td-meter ${view.placement}`} aria-hidden="true">
                <i style={{ width: `${clearedPercent}%` }} />
              </div>
              {view.placement === "away" ? (
                <p className="td-note">This Task is {task.status === "closed" ? "closed" : "archived"}, so the pipeline no longer asks about it. Its answers so far are kept below.</p>
              ) : null}
              <ol className="td-spine">
                {view.steps.map((step) => (
                  <PipelineStep
                    key={step.milestone.id}
                    step={step}
                    nowEpochMs={nowEpochMs}
                    running={running === step.milestone.routineId
                      || (runtime?.processingTaskId === task.id
                        && checkingRoutineIds.has(step.milestone.routineId))}
                    settingPosition={settingPosition}
                    controlsBusy={running !== undefined || settingPosition !== undefined}
                    canSetPosition={view.placement !== "away"}
                    checkNow={checkNow}
                    setPosition={setPosition}
                  />
                ))}
                <li className={`td-step terminus ${view.placement === "done" ? "passed" : "ahead"}`}>
                  <span className="td-node" aria-hidden="true" />
                  <div className="td-step-body">
                    <span className="td-terminus">
                      {view.placement === "done" ? "Done — every stage completed" : "Done"}
                    </span>
                    {view.placement !== "away" ? (
                      <button
                        type="button"
                        className="td-set-position"
                        disabled={settingPosition !== undefined || running !== undefined || view.placement === "done"}
                        aria-label="Set Task after the final delivery pipeline step"
                        onClick={() => void setPosition(view.steps.length)}
                      >{settingPosition === view.steps.length ? "Setting…" : "Mark done"}</button>
                    ) : null}
                  </div>
                </li>
              </ol>
            </> : <div className="td-empty">
              <p>This Project has no delivery pipeline yet, so nothing is tracking this Task from here to done.</p>
              <button type="button" className="td-open-playbook" onClick={props.openPlaybook}>
                <Icon name="sparkles" />Build the pipeline
              </button>
            </div>}
        </section>

        {brief ? (
          <details className="td-block td-steward">
            <summary><h2>Steward brief</h2></summary>
            <p className="td-prose mono">{brief}</p>
          </details>
        ) : null}
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
