import { useEffect, useState } from "react";
import type { AgentLibraryEntry, WorkflowConfigurationDto, WorkflowStepDto, WorkflowStepResultDto } from "@termloop/contract/current";
import type { Task, WorkflowConfiguration, WorkflowExecution } from "../model.js";
import type { RowTone } from "../row-tone.js";
import { Icon } from "./Icon.js";
import { OverlayPortal } from "./OverlayPortal.js";
import { stepKindLabel, agentLabel, workflowSummary, workflowExecutionSummary, workflowStatusLabel, workflowPhaseLabel, workflowStepParticipant, workflowStepResult, workflowStepState, workflowStepSessionId, workflowStepResultLabel, workflowStepResultFileName } from "./workflow-presentation.js";
export { WorkflowEditorPanel, initialWorkflowSteps, moveWorkflowStep } from "./WorkflowEditorPanel.js";
export { nextStepId, workflowStepResultFileName } from "./workflow-presentation.js";

export type WorkflowSessionPresentation = {
  agentLabel: string;
  stateLabel: string;
  tone: RowTone;
};

export function TaskWorkflowLaunchers(props: {
  task: Task;
  configurations: readonly WorkflowConfiguration[];
  executions: readonly WorkflowExecution[];
  agentProfiles: readonly AgentLibraryEntry[];
  launchable: boolean;
  showLaunchers: boolean;
  overlayContainer: Element | undefined;
  overlayVisibilityChanged(visible: boolean): void;
  edit(configuration: WorkflowConfigurationDto | undefined): void;
  launch(taskId: string, workflowId: string, goal: string): Promise<string | undefined>;
  cancel(executionId: string): Promise<string | undefined>;
  openSession(sessionId: string): void;
  sessionPresentation(sessionId: string): WorkflowSessionPresentation | undefined;
}) {
  const execution = props.executions.find((candidate) => candidate.taskId === props.task.id);
  const executionActive = execution !== undefined && execution.status !== "completed";
  const [running, setRunning] = useState<WorkflowConfigurationDto>();
  const [inspectingExecution, setInspectingExecution] = useState(false);
  const [inspectingResult, setInspectingResult] = useState<{ stepId: string; reviewCycle: number }>();
  const [progressPreference, setProgressPreference] = useState<{ executionId: string; expanded: boolean }>();
  const inspectedStep = execution?.steps.find((step) => step.id === inspectingResult?.stepId);
  const inspectedResult = execution?.stepResults.find((result) => result.stepId === inspectingResult?.stepId
    && result.reviewCycle === inspectingResult.reviewCycle);
  const progressExpanded = execution !== undefined && (progressPreference?.executionId === execution.id
    ? progressPreference.expanded
    : executionActive);
  const { overlayVisibilityChanged } = props;
  useEffect(() => {
    overlayVisibilityChanged(Boolean(running || (inspectingExecution && execution) || (inspectedStep && inspectedResult)));
    return () => overlayVisibilityChanged(false);
  }, [execution, inspectedResult, inspectedStep, inspectingExecution, overlayVisibilityChanged, running]);

  return <>
    {execution ? <button
      type="button"
      className={`workflow-execution-chip status-${execution.status}`}
      title={workflowExecutionSummary(execution)}
      aria-label={`${progressExpanded ? "Hide" : "Show"} ${execution.workflowName} workflow steps`}
      aria-expanded={progressExpanded}
      onClick={() => setProgressPreference({ executionId: execution.id, expanded: !progressExpanded })}
    >
      <span className="workflow-execution-dot" aria-hidden="true" />
      <Icon name="branch" />
      <span>{execution.workflowName}</span>
      <b>{execution.status === "completed" ? workflowStatusLabel(execution) : `${Math.min(execution.currentStepIndex + 1, execution.steps.length)}/${execution.steps.length}`}</b>
      <Icon name="chevronDown" className={`workflow-disclosure${progressExpanded ? " expanded" : ""}`} />
    </button> : null}
    {execution && progressExpanded ? <WorkflowSidebarProgress
      execution={execution}
      agentProfiles={props.agentProfiles}
      openSession={props.openSession}
      sessionPresentation={props.sessionPresentation}
      showDetails={() => setInspectingExecution(true)}
      showResult={(step, result) => setInspectingResult({ stepId: step.id, reviewCycle: result.reviewCycle })}
    /> : null}
    {props.showLaunchers ? <section className="workflow-template-launchers" aria-label="Workflow templates">
      <header><span>Workflow templates</span><button
        type="button"
        className="workflow-add"
        title={props.configurations.length >= 16 ? "This project has reached its limit of 16 templates" : "Create a new reusable workflow template"}
        aria-label="New workflow template"
        disabled={props.configurations.length >= 16}
        onClick={() => props.edit(undefined)}
      ><Icon name="add" />New template</button></header>
      {props.configurations.length === 0 ? <p>Create a template, then run it with a goal in any Task.</p> : null}
      {props.configurations.length ? <details className="workflow-saved-templates" open={props.configurations.length === 1 && !executionActive}>
        <summary>{props.configurations.length} saved {props.configurations.length === 1 ? "template" : "templates"} · run or edit</summary>
      {props.configurations.map((configuration) => (
      <span className="run-chip workflow-chip" key={configuration.id}>
        <button
          type="button"
          className="run-chip-start"
          disabled={!props.launchable || executionActive}
          title={!props.launchable
            ? "The Task worktree must be ready before this workflow can run"
            : executionActive
              ? `Finish or stop ${execution?.workflowName ?? "the current workflow"} first`
              : workflowSummary(configuration)}
          aria-label={`Run workflow ${configuration.name} in ${props.task.title}`}
          onClick={() => setRunning(configuration)}
        ><Icon name="play" /><span><small>Run workflow</small>{configuration.name}</span></button>
        <button
          type="button"
          className="run-chip-edit"
          title={`Edit template ${configuration.name}`}
          aria-label={`Edit template ${configuration.name}`}
          onClick={() => props.edit(configuration)}
        ><Icon name="edit" /></button>
      </span>
      ))}
      </details> : null}
    </section> : null}
    <OverlayPortal container={props.overlayContainer}>
      {running ? <WorkflowRunDialog
        task={props.task}
        configuration={running}
        close={() => setRunning(undefined)}
        launch={props.launch}
      /> : null}
      {inspectingExecution && execution ? <WorkflowExecutionDialog
        execution={execution}
        agentProfiles={props.agentProfiles}
        close={() => setInspectingExecution(false)}
        cancel={props.cancel}
        openSession={props.openSession}
        sessionPresentation={props.sessionPresentation}
      /> : null}
      {execution && inspectedStep && inspectedResult ? <WorkflowStepResultDialog
        execution={execution}
        agentProfiles={props.agentProfiles}
        step={inspectedStep}
        result={inspectedResult}
        close={() => setInspectingResult(undefined)}
        openSession={props.openSession}
        sessionPresentation={props.sessionPresentation}
      /> : null}
    </OverlayPortal>
  </>;
}

function WorkflowSidebarProgress(props: {
  execution: WorkflowExecution;
  agentProfiles: readonly AgentLibraryEntry[];
  openSession(sessionId: string): void;
  sessionPresentation(sessionId: string): WorkflowSessionPresentation | undefined;
  showDetails(): void;
  showResult(step: WorkflowStepDto, result: WorkflowStepResultDto): void;
}) {
  const currentStep = props.execution.steps[props.execution.currentStepIndex];
  const coordinatorPresentation = props.sessionPresentation(props.execution.coordinatorSessionId);
  return <section className="workflow-sidebar-progress" aria-label={`${props.execution.workflowName} workflow progress`}>
    <header>
      <span>{workflowPhaseLabel(props.execution, currentStep)}</span>
      <button type="button" onClick={props.showDetails}>Details</button>
      <span className="workflow-coordinator-summary">
        <strong>Coordinator</strong>
        <WorkflowSessionButton
          sessionId={props.execution.coordinatorSessionId}
          presentation={coordinatorPresentation}
          fallbackLabel="Coordinator"
          openSession={props.openSession}
        />
      </span>
    </header>
    <ol>
      {props.execution.steps.map((step, index) => {
        const result = workflowStepResult(props.execution, step.id);
        const state = workflowStepState(props.execution, index, result);
        const participantSessionId = workflowStepSessionId(props.execution, step);
        return <li key={step.id} className={`kind-${step.kind} ${state}`} aria-current={state === "current" ? "step" : undefined}>
          <span className="workflow-sidebar-marker" aria-hidden="true">{state === "complete" ? "✓" : state === "skipped" ? "–" : index + 1}</span>
          <span className="workflow-sidebar-step-copy">
            <span className="workflow-sidebar-step-head">
              <b>{step.title}</b>
            </span>
            <WorkflowParticipantSession
              step={step}
              steps={props.execution.steps}
              agentProfiles={props.agentProfiles}
              sessionId={participantSessionId}
              presentation={participantSessionId ? props.sessionPresentation(participantSessionId) : undefined}
              coordinatorSessionId={props.execution.coordinatorSessionId}
              openSession={props.openSession}
            />
            {result ? <button
              type="button"
              className={`workflow-result-file outcome-${result.outcome}`}
              aria-label={`Open ${workflowStepResultFileName(step, props.execution.steps)}`}
              title={`Open ${workflowStepResultFileName(step, props.execution.steps)}`}
              onClick={() => props.showResult(step, result)}
            >
              <Icon name="fileText" />
              <span>{workflowStepResultFileName(step, props.execution.steps)}</span>
              <small>{workflowStepResultLabel(step.kind, result.outcome)}</small>
            </button> : state === "current" ? <small className="workflow-step-waiting">{workflowPhaseLabel(props.execution, step)}</small> : null}
          </span>
        </li>;
      })}
    </ol>
  </section>;
}

function WorkflowStepResultDialog(props: {
  execution: WorkflowExecution;
  agentProfiles: readonly AgentLibraryEntry[];
  step: WorkflowStepDto;
  result: WorkflowStepResultDto;
  close(): void;
  openSession(sessionId: string): void;
  sessionPresentation(sessionId: string): WorkflowSessionPresentation | undefined;
}) {
  const participantSessionId = workflowStepSessionId(props.execution, props.step);
  const fileName = workflowStepResultFileName(props.step, props.execution.steps);
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && props.close()}>
    <button className="dialog-backdrop" aria-label={`Close ${fileName}`} onClick={props.close} />
    <section className="dialog-card workflow-result-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-result-title">
      <header className="dialog-header">
        <div>
          <span className="dialog-eyebrow">Workflow result</span>
          <h2 id="workflow-result-title"><Icon name="fileText" />{fileName}</h2>
        </div>
        <button className="icon-button quiet" aria-label="Close workflow result" onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="dialog-body">
        <div className="workflow-result-heading">
          <span className={`workflow-kind kind-${props.step.kind}`}>{stepKindLabel(props.step.kind)}</span>
          <strong>{props.step.title}</strong>
          <small>{workflowStepResultLabel(props.step.kind, props.result.outcome)} · cycle {props.result.reviewCycle}</small>
        </div>
        <WorkflowParticipantSession
          step={props.step}
          steps={props.execution.steps}
          agentProfiles={props.agentProfiles}
          sessionId={participantSessionId}
          presentation={participantSessionId ? props.sessionPresentation(participantSessionId) : undefined}
          coordinatorSessionId={props.execution.coordinatorSessionId}
          openSession={props.openSession}
        />
        <article className="workflow-result-document"><p>{props.result.summary}</p></article>
      </div>
      <footer className="dialog-actions">
        <button type="button" className="secondary-button" onClick={props.close}>Close</button>
      </footer>
    </section>
  </div>;
}

function WorkflowExecutionDialog(props: {
  execution: WorkflowExecution;
  agentProfiles: readonly AgentLibraryEntry[];
  close(): void;
  cancel(executionId: string): Promise<string | undefined>;
  openSession(sessionId: string): void;
  sessionPresentation(sessionId: string): WorkflowSessionPresentation | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const currentStep = props.execution.steps[props.execution.currentStepIndex];
  const stop = async () => {
    setBusy(true); setError(undefined);
    try {
      const failure = await props.cancel(props.execution.id);
      if (failure) { setError(failure); return; }
      props.close();
    } finally { setBusy(false); }
  };
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && !busy && props.close()}>
    <button className="dialog-backdrop" aria-label="Close workflow progress" onClick={props.close} />
    <section className="dialog-card workflow-progress-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-progress-title">
      <header className="dialog-header">
        <div><span className="dialog-eyebrow">Workflow progress</span><h2 id="workflow-progress-title">{props.execution.workflowName}</h2></div>
        <span className={`workflow-status-badge status-${props.execution.status}`}><i aria-hidden="true" />{workflowStatusLabel(props.execution)}</span>
        <button className="icon-button quiet" aria-label="Close dialog" disabled={busy} onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="dialog-body">
        <div className="workflow-progress-current">
          <span>{props.execution.status === "completed" ? "Finished" : currentStep ? `${stepKindLabel(currentStep.kind)} · step ${props.execution.currentStepIndex + 1} of ${props.execution.steps.length}` : "Workflow"}</span>
          <strong>{workflowPhaseLabel(props.execution, currentStep)}</strong>
          <span className="workflow-coordinator-summary">
            <small>Coordinator</small>
            <WorkflowSessionButton
              sessionId={props.execution.coordinatorSessionId}
              presentation={props.sessionPresentation(props.execution.coordinatorSessionId)}
              fallbackLabel="Coordinator"
              openSession={props.openSession}
            />
          </span>
          {props.execution.steps.some((step) => step.kind === "review") && props.execution.status !== "completed"
            ? <small>Review cycle {props.execution.reviewCycle} of {props.execution.maxReviewCycles}</small>
            : null}
        </div>
        <ol className="workflow-progress-steps">
          {props.execution.steps.map((step, index) => {
            const result = workflowStepResult(props.execution, step.id);
            const state = workflowStepState(props.execution, index, result);
            const participantSessionId = workflowStepSessionId(props.execution, step);
            return <li key={step.id} className={`kind-${step.kind} ${state}`} aria-current={state === "current" ? "step" : undefined}>
              <span className="workflow-progress-marker">{state === "complete" ? "✓" : state === "skipped" ? "–" : index + 1}</span>
              <span>
                <b>{step.title}</b>
                <WorkflowParticipantSession
                  step={step}
                  steps={props.execution.steps}
                  agentProfiles={props.agentProfiles}
                  sessionId={participantSessionId}
                  presentation={participantSessionId ? props.sessionPresentation(participantSessionId) : undefined}
                  coordinatorSessionId={props.execution.coordinatorSessionId}
                  openSession={props.openSession}
                />
                {result ? <span className={`workflow-step-result outcome-${result.outcome}`}>
                  <strong>{workflowStepResultLabel(step.kind, result.outcome)}</strong>
                  {result.reviewCycle < props.execution.reviewCycle ? <em>Cycle {result.reviewCycle}</em> : null}
                  <small>{result.summary}</small>
                </span> : null}
              </span>
              <span className={`workflow-kind kind-${step.kind}`}>{stepKindLabel(step.kind)}</span>
            </li>;
          })}
        </ol>
        <div className="workflow-progress-goal"><span>Run goal</span><p>{props.execution.goal}</p></div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions">
        <p className="workflow-stop-help">Stopping ends this workflow. Existing agent conversations stay open.</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={props.close}>Close</button>
        {props.execution.status !== "completed" ? <button type="button" className="danger-button" disabled={busy} onClick={() => void stop()}>{busy ? "Stopping…" : "Stop automation"}</button> : null}
      </footer>
    </section>
  </div>;
}

function WorkflowParticipantSession(props: {
  step: WorkflowStepDto;
  steps: readonly WorkflowStepDto[];
  agentProfiles: readonly AgentLibraryEntry[];
  sessionId: string | undefined;
  presentation: WorkflowSessionPresentation | undefined;
  coordinatorSessionId: string;
  openSession(sessionId: string): void;
}) {
  const plannedParticipant = workflowStepParticipant(props.step, props.steps, props.agentProfiles);
  const sessionId = props.sessionId;
  if (!sessionId) return <small className="workflow-participant-planned">{plannedParticipant}</small>;
  return <WorkflowSessionButton
    sessionId={sessionId}
    presentation={props.presentation}
    fallbackLabel={plannedParticipant}
    badge={sessionId === props.coordinatorSessionId ? "same coordinator" : props.step.reuseStepId ? "same session" : undefined}
    openSession={props.openSession}
  />;
}

function WorkflowSessionButton(props: {
  sessionId: string;
  presentation: WorkflowSessionPresentation | undefined;
  fallbackLabel: string;
  badge?: string | undefined;
  openSession(sessionId: string): void;
}) {
  if (!props.presentation) return <button
    type="button"
    className="workflow-participant-link"
    title={`Open ${props.fallbackLabel}`}
    onClick={() => props.openSession(props.sessionId)}
  >{props.fallbackLabel}</button>;
  return <button
    type="button"
    className="workflow-participant-session"
    data-tone={props.presentation.tone}
    data-workflow-session-id={props.sessionId}
    title={`Open ${props.presentation.agentLabel} — ${props.presentation.stateLabel}`}
    aria-label={`Open ${props.presentation.agentLabel} — ${props.presentation.stateLabel}`}
    onClick={() => props.openSession(props.sessionId)}
  >
    <i aria-hidden="true" />
    <b>{props.presentation.agentLabel}</b>
    <small>{props.presentation.stateLabel}</small>
    {props.badge ? <em>{props.badge}</em> : null}
  </button>;
}

function WorkflowRunDialog(props: {
  task: Task;
  configuration: WorkflowConfigurationDto;
  close(): void;
  launch(taskId: string, workflowId: string, goal: string): Promise<string | undefined>;
}) {
  const [goal, setGoal] = useState(() => props.task.brief?.trim() || props.task.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const start = async () => {
    const normalized = goal.trim();
    if (!normalized) { setError("Describe what this workflow should accomplish."); return; }
    setBusy(true); setError(undefined);
    try {
      const failure = await props.launch(props.task.id, props.configuration.id, normalized);
      if (failure) { setError(failure); return; }
      props.close();
    } finally { setBusy(false); }
  };
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && !busy && props.close()}>
    <button className="dialog-backdrop" aria-label="Cancel workflow launch" disabled={busy} onClick={props.close} />
    <section className="dialog-card workflow-run-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-run-title">
      <header className="dialog-header">
        <div><span className="dialog-eyebrow">Run workflow</span><h2 id="workflow-run-title">{props.configuration.name}</h2></div>
        <button className="icon-button quiet" aria-label="Close dialog" disabled={busy} onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="dialog-body">
        <div className="workflow-run-route" aria-label="Workflow steps">
          {workflowSummary(props.configuration).split(" → ").map((label, index) => <span key={index} className="workflow-run-node">
            {index > 0 ? <i aria-hidden="true">→</i> : null}<b>{label}</b>
          </span>)}
        </div>
        <label htmlFor="workflow-run-goal">What should this run accomplish?</label>
        <textarea id="workflow-run-goal" autoFocus rows={5} maxLength={32768} value={goal} onChange={(event) => setGoal(event.target.value)} />
        <p className="field-help">This goal applies only to this Task. The template stays reusable; your lead agent carries the goal through every step.</p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={props.close}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void start()}><Icon name="play" />{busy ? "Starting…" : "Start workflow"}</button>
      </footer>
    </section>
  </div>;
}
