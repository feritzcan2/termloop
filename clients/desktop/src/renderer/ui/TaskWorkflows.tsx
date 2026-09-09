import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { AgentLibraryEntry, WorkflowConfigurationDto, WorkflowStepDto, WorkflowStepResultDto } from "@termloop/contract/current";
import type { Project, Task, WorkflowConfiguration, WorkflowExecution } from "../model.js";
import type { RowTone } from "../row-tone.js";
import { Icon } from "./Icon.js";
import { OverlayPortal } from "./OverlayPortal.js";
import { WorkflowTemplateMenu } from "./WorkflowTemplateMenu.js";
import { stepKindLabel, agentLabel, workflowSummary, workflowExecutionSummary, workflowStatusLabel, workflowPhaseLabel, workflowStepParticipant, workflowStepResult, workflowStepState, workflowStepSessionId, workflowStepResultLabel, workflowStepResultFileName } from "./workflow-presentation.js";
export { WorkflowEditorPanel, initialWorkflowSteps, moveWorkflowStep } from "./WorkflowEditorPanel.js";
export { nextStepId, workflowStepResultFileName } from "./workflow-presentation.js";

export type WorkflowSessionPresentation = {
  agentLabel: string;
  stateLabel: string;
  tone: RowTone;
};

type WorkflowLaunchScope = { task: Task; project?: never } | { task?: never; project: Project };

export function TaskWorkflowLaunchers(props: Extract<ComponentProps<typeof WorkflowLaunchers>, { task: Task }>) {
  return <WorkflowLaunchers {...props} />;
}

export function WorkflowLaunchers(props: WorkflowLaunchScope & {
  configurations: readonly WorkflowConfiguration[];
  executions: readonly WorkflowExecution[];
  agentProfiles: readonly AgentLibraryEntry[];
  launchable: boolean;
  disabled?: boolean;
  showLaunchers: boolean;
  renderLaunchers?(workflowButton: ReactNode): ReactNode;
  overlayContainer: Element | undefined;
  overlayVisibilityChanged(visible: boolean): void;
  edit(configuration: WorkflowConfigurationDto | undefined): void;
  launch(taskId: string, workflowId: string, goal: string): Promise<string | undefined>;
  cancel(executionId: string): Promise<string | undefined>;
  openSession(sessionId: string): void;
  sessionPresentation(sessionId: string): WorkflowSessionPresentation | undefined;
}) {
  const scopeId = props.task ? props.task.id : props.project.id;
  const scopeTitle = props.task ? props.task.title : props.project.name;
  const execution = props.executions.find((candidate) => props.task
    ? candidate.taskId === props.task.id && candidate.projectId === props.task.project_id
    : candidate.taskId === null && candidate.projectId === props.project.id);
  const executionActive = execution !== undefined && execution.status !== "completed";
  const executionNeedsAttention = execution?.status === "completed"
    && (execution.completionOutcome === "changesRequested" || execution.completionOutcome === "reviewLimitReached");
  const currentStep = execution?.steps[execution.currentStepIndex];
  const executionSummaryId = useId();
  const [running, setRunning] = useState<WorkflowConfigurationDto>();
  const trigger = useRef<HTMLButtonElement>(null);
  const [templateTrigger, setTemplateTrigger] = useState<HTMLButtonElement>();
  const templatesOpen = props.showLaunchers && !props.disabled && templateTrigger !== undefined;
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
    overlayVisibilityChanged(Boolean(templatesOpen || running || (inspectingExecution && execution) || (inspectedStep && inspectedResult)));
    return () => overlayVisibilityChanged(false);
  }, [execution, inspectedResult, inspectedStep, inspectingExecution, overlayVisibilityChanged, running, templatesOpen]);
  useEffect(() => {
    if (!props.showLaunchers || props.disabled) {
      setTemplateTrigger(undefined); setRunning(undefined); setInspectingExecution(false); setInspectingResult(undefined);
    }
  }, [props.showLaunchers, props.disabled]);
  const closeTemplates = () => { setTemplateTrigger(undefined); templateTrigger?.focus(); };
  const workflowButton = <button
    ref={trigger}
    type="button"
    className={`workflow-add${props.project ? " workspace-workflow" : ""}`}
    disabled={props.disabled}
    aria-label="Workflow"
    aria-haspopup={props.configurations.length || (props.project && execution) ? "menu" : undefined}
    aria-expanded={templatesOpen}
    title={props.configurations.length ? "Run or edit a workflow" : "Create a workflow template"}
    onClick={(event) => props.configurations.length || (props.project && execution) ? setTemplateTrigger(event.currentTarget) : props.edit(undefined)}
  ><Icon name="add" />Workflow</button>;

  return <>
    {props.showLaunchers ? props.renderLaunchers
      ? props.renderLaunchers(workflowButton)
      : <div className="task-launch">{workflowButton}</div> : null}
    {execution && props.task ? <section
      className={`workflow-execution-row status-${execution.status}${executionNeedsAttention ? " needs-attention" : ""}`}
      aria-label={`${execution.workflowName} workflow`}
    >
      <button
        type="button"
        className="workflow-execution-toggle"
        title={`${workflowExecutionSummary(execution)}\n${workflowPhaseLabel(execution, currentStep)}`}
        aria-label={`${progressExpanded ? "Hide" : "Show"} ${execution.workflowName} workflow steps`}
        aria-describedby={`${executionSummaryId}-state ${executionSummaryId}-detail`}
        aria-expanded={progressExpanded}
        onClick={() => setProgressPreference({ executionId: execution.id, expanded: !progressExpanded })}
      >
        <span className="workflow-execution-symbol" aria-hidden="true">
          {executionActive ? <Icon name="branch" /> : executionNeedsAttention ? "!" : "✓"}
        </span>
        <span className="workflow-execution-name">{execution.workflowName}</span>
        <span id={`${executionSummaryId}-state`} className="workflow-execution-state">{executionActive ? workflowStatusLabel(execution) : "Completed"}</span>
        <Icon name="chevronDown" className={`workflow-disclosure${progressExpanded ? " expanded" : ""}`} />
        <span id={`${executionSummaryId}-detail`} className="workflow-execution-detail">
          {executionActive
            ? currentStep ? `Step ${execution.currentStepIndex + 1} of ${execution.steps.length} · ${currentStep.title}` : "Waiting for the next step"
            : executionNeedsAttention ? workflowStatusLabel(execution)
              : execution.completionOutcome === "approved" ? "All reviewers approved" : "No final review approval recorded"}
        </span>
      </button>
      {progressExpanded ? <WorkflowSidebarProgress
        execution={execution}
        agentProfiles={props.agentProfiles}
        openSession={props.openSession}
        sessionPresentation={props.sessionPresentation}
        showDetails={() => setInspectingExecution(true)}
        showResult={(step, result) => setInspectingResult({ stepId: step.id, reviewCycle: result.reviewCycle })}
      /> : null}
    </section> : null}
    <OverlayPortal container={props.overlayContainer}>
      {templatesOpen ? <WorkflowTemplateMenu
        anchor={templateTrigger}
        taskTitle={scopeTitle}
        configurations={props.configurations}
        unavailableReason={!props.launchable
          ? props.task ? "The Task worktree must be ready before a workflow can run." : "Connect to this Project before starting a workflow."
          : executionActive ? `Finish or stop ${execution.workflowName} first.` : undefined}
        currentWorkflow={props.project && execution ? {
          name: execution.workflowName,
          status: workflowStatusLabel(execution),
          open: () => { closeTemplates(); setInspectingExecution(true); },
        } : undefined}
        close={closeTemplates}
        run={(configuration) => { closeTemplates(); setRunning(configuration); }}
        edit={(configuration) => { closeTemplates(); props.edit(configuration); }}
      /> : null}
      {running ? <WorkflowRunDialog
        initialGoal={props.task ? props.task.brief?.trim() || props.task.title : ""}
        project={props.project}
        configuration={running}
        close={() => { setRunning(undefined); trigger.current?.focus(); }}
        launch={(goal) => props.launch(scopeId, running.id, goal)}
        unavailableReason={!props.launchable ? "This checkout is not available for launch."
          : executionActive ? `Finish or stop ${execution.workflowName} first.`
          : props.configurations.find((configuration) => configuration.id === running.id)?.generation !== running.generation
            ? "This template changed or was deleted. Close this dialog and select it again." : undefined}
      /> : null}
      {inspectingExecution && execution ? <WorkflowExecutionDialog
        execution={execution}
        agentProfiles={props.agentProfiles}
        close={() => { setInspectingExecution(false); trigger.current?.focus(); }}
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
  initialGoal: string;
  project?: Project | undefined;
  configuration: WorkflowConfigurationDto;
  unavailableReason?: string | undefined;
  close(): void;
  launch(goal: string): Promise<string | undefined>;
}) {
  const [goal, setGoal] = useState(props.initialGoal);
  const starting = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const start = async () => {
    if (starting.current || props.unavailableReason) return;
    const normalized = goal.trim();
    if (!normalized) { setError("Describe what this workflow should accomplish."); return; }
    starting.current = true; setBusy(true); setError(undefined);
    try {
      const failure = await props.launch(normalized);
      if (failure) { setError(failure); return; }
      props.close();
    } catch { setError("Could not start this workflow. Check your connection and try again."); }
    finally { starting.current = false; setBusy(false); }
  };
  return <div className="dialog-layer" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) props.close(); }
    if (event.key === "Tab") {
      const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') ?? [])];
      const first = elements[0]; const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <button className="dialog-backdrop" aria-label="Cancel workflow launch" disabled={busy} onClick={props.close} />
    <section ref={dialog} className="dialog-card workflow-run-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-run-title">
      <header className="dialog-header">
        <div><span className="dialog-eyebrow">Run workflow</span><h2 id="workflow-run-title">{props.configuration.name}</h2></div>
        <button className="icon-button quiet" aria-label="Close dialog" disabled={busy} onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="dialog-body">
        {props.project ? <div className="workflow-run-scope">
          <strong>Project checkout · {props.project.name}</strong>
          <code>{props.project.folder_path}</code>
          <p>No Task or isolated worktree will be created. Changes apply directly to this checkout.</p>
        </div> : null}
        <div className="workflow-run-route" aria-label="Workflow steps">
          {workflowSummary(props.configuration).split(" → ").map((label, index) => <span key={index} className="workflow-run-node">
            {index > 0 ? <i aria-hidden="true">→</i> : null}<b>{label}</b>
          </span>)}
        </div>
        <label htmlFor="workflow-run-goal">What should this run accomplish?</label>
        <textarea id="workflow-run-goal" autoFocus rows={5} maxLength={8192} disabled={busy} value={goal} onChange={(event) => setGoal(event.target.value)} />
        <p className="field-help">This goal applies only to this {props.project ? "run" : "Task"}. The template stays reusable; your lead agent carries the goal through every step.</p>
        {props.unavailableReason ? <p className="form-error" role="alert">{props.unavailableReason}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={props.close}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy || Boolean(props.unavailableReason)} onClick={() => void start()}><Icon name="play" />{busy ? "Starting…" : "Start workflow"}</button>
      </footer>
    </section>
  </div>;
}
