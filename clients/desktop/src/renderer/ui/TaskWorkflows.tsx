import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AgentCapabilityDto,
  StewardAgentId,
  WorkflowConfigurationCreateParams,
  WorkflowConfigurationDto,
  WorkflowConfigurationUpdateParams,
  WorkflowStepDto,
  WorkflowStepKind,
  WorkflowStepResultDto,
} from "@termloop/contract/current";
import type { Task, WorkflowConfiguration, WorkflowExecution } from "../model.js";
import type { RowTone } from "../row-tone.js";
import { Icon } from "./Icon.js";
import { OverlayPortal } from "./OverlayPortal.js";

export type WorkflowSessionPresentation = {
  agentLabel: string;
  stateLabel: string;
  tone: RowTone;
};

export function TaskWorkflowLaunchers(props: {
  task: Task;
  configurations: readonly WorkflowConfiguration[];
  executions: readonly WorkflowExecution[];
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
    {props.showLaunchers ? <span className="task-launch-divider" aria-hidden="true" /> : null}
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
      <b>{execution.status === "completed" ? "Done" : `${Math.min(execution.currentStepIndex + 1, execution.steps.length)}/${execution.steps.length}`}</b>
      <Icon name="chevronDown" className={`workflow-disclosure${progressExpanded ? " expanded" : ""}`} />
    </button> : null}
    {props.showLaunchers ? props.configurations.map((configuration) => (
      <span className="run-chip workflow-chip" key={configuration.id}>
        <button
          type="button"
          className="run-chip-start"
          disabled={!props.launchable || executionActive}
          title={executionActive ? `Finish or stop ${execution?.workflowName ?? "the current workflow"} first` : workflowSummary(configuration)}
          aria-label={`Run workflow ${configuration.name} in ${props.task.title}`}
          onClick={() => setRunning(configuration)}
        ><Icon name="branch" />{configuration.name}</button>
        <button
          type="button"
          className="run-chip-edit"
          title={`Edit ${configuration.name}`}
          aria-label={`Edit workflow ${configuration.name}`}
          onClick={() => props.edit(configuration)}
        ><Icon name="edit" /></button>
      </span>
    )) : null}
    {props.showLaunchers ? <button
      type="button"
      className="workflow-add"
      title="Add workflow"
      aria-label="Add workflow"
      onClick={() => props.edit(undefined)}
    ><Icon name="add" />Workflow</button> : null}
    {execution && progressExpanded ? <WorkflowSidebarProgress
      execution={execution}
      openSession={props.openSession}
      sessionPresentation={props.sessionPresentation}
      showDetails={() => setInspectingExecution(true)}
      showResult={(step, result) => setInspectingResult({ stepId: step.id, reviewCycle: result.reviewCycle })}
    /> : null}
    <OverlayPortal container={props.overlayContainer}>
      {running ? <WorkflowRunDialog
        task={props.task}
        configuration={running}
        close={() => setRunning(undefined)}
        launch={props.launch}
      /> : null}
      {inspectingExecution && execution ? <WorkflowExecutionDialog
        execution={execution}
        close={() => setInspectingExecution(false)}
        cancel={props.cancel}
        openSession={props.openSession}
        sessionPresentation={props.sessionPresentation}
      /> : null}
      {execution && inspectedStep && inspectedResult ? <WorkflowStepResultDialog
        execution={execution}
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
        <span className={`workflow-status-badge status-${props.execution.status}`}><i aria-hidden="true" />{workflowStatusLabel(props.execution.status)}</span>
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
        <p className="workflow-stop-help">Stopping ends Core automation. Existing Agent Sessions stay open.</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={props.close}>Close</button>
        {props.execution.status !== "completed" ? <button type="button" className="danger-button" disabled={busy} onClick={() => void stop()}>{busy ? "Stopping…" : "Stop automation"}</button> : null}
      </footer>
    </section>
  </div>;
}

function WorkflowParticipantSession(props: {
  step: WorkflowStepDto;
  steps: readonly WorkflowStepDto[];
  sessionId: string | undefined;
  presentation: WorkflowSessionPresentation | undefined;
  coordinatorSessionId: string;
  openSession(sessionId: string): void;
}) {
  const plannedParticipant = workflowStepParticipant(props.step, props.steps);
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
    <button className="dialog-backdrop" aria-label="Cancel workflow launch" onClick={props.close} />
    <section className="dialog-card workflow-run-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-run-title">
      <header className="dialog-header">
        <div><span className="dialog-eyebrow">Run workflow</span><h2 id="workflow-run-title">{props.configuration.name}</h2></div>
        <button className="icon-button quiet" aria-label="Close dialog" disabled={busy} onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="dialog-body">
        <div className="workflow-run-route" aria-label="Workflow steps">
          {props.configuration.steps.map((step, index) => <span key={step.id} className={`workflow-run-node kind-${step.kind}`}>
            {index > 0 ? <i aria-hidden="true">→</i> : null}<b>{stepKindLabel(step.kind)}</b>
          </span>)}
        </div>
        <label htmlFor="workflow-run-goal">What should this run accomplish?</label>
        <textarea id="workflow-run-goal" autoFocus rows={5} maxLength={32768} value={goal} onChange={(event) => setGoal(event.target.value)} />
        <p className="field-help">The template stays reusable. Core keeps this goal while it routes each step and reuses the configured Agent conversations.</p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={props.close}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void start()}><Icon name="play" />{busy ? "Starting…" : "Start workflow"}</button>
      </footer>
    </section>
  </div>;
}

type WorkflowDraft = {
  name: string;
  coordinatorAgentId: StewardAgentId;
  maxReviewCycles: number;
  steps: WorkflowStepDto[];
};

export function WorkflowEditorPanel(props: {
  projectId: string;
  configuration?: WorkflowConfigurationDto | undefined;
  stateRevision: number;
  agentCapabilities: readonly AgentCapabilityDto[];
  close(): void;
  save(params: WorkflowConfigurationCreateParams | WorkflowConfigurationUpdateParams): Promise<WorkflowConfigurationDto | string>;
  remove(workflowId: string): Promise<string | undefined>;
}) {
  const agents = useMemo(() => workflowAgents(props.agentCapabilities), [props.agentCapabilities]);
  const [draft, setDraft] = useState<WorkflowDraft>(() => workflowDraft(props.configuration));
  const [selectedStepId, setSelectedStepId] = useState(() => draft.steps[0]?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const selectedStep = draft.steps.find((step) => step.id === selectedStepId) ?? draft.steps[0];
  const discussions = draft.steps.filter((step) => step.kind === "discuss");
  const implementation = draft.steps.find((step) => step.kind === "implement");
  const reviews = draft.steps.filter((step) => step.kind === "review");
  const fix = draft.steps.find((step) => step.kind === "fix");

  const updateStep = (id: string, update: Partial<WorkflowStepDto>) => {
    setDraft((current) => ({
      ...current,
      steps: sanitizeReuse(current.steps.map((step) => step.id === id ? { ...step, ...update } : step)),
    }));
    setConfirmingDelete(false);
  };
  const addStep = (kind: "discuss" | "review") => {
    const helperAgentId: StewardAgentId = kind === "discuss" ? "claude" : "codex";
    const step = defaultStep(kind, draft.steps, helperAgentId);
    setDraft((current) => {
      const implementAt = current.steps.findIndex((candidate) => candidate.kind === "implement");
      const fixAt = current.steps.findIndex((candidate) => candidate.kind === "fix");
      const insertAt = kind === "discuss" ? implementAt : (fixAt < 0 ? current.steps.length : fixAt);
      const steps = [...current.steps];
      steps.splice(insertAt, 0, step);
      return { ...current, steps };
    });
    setSelectedStepId(step.id);
  };
  const addFixStep = () => {
    const step: WorkflowStepDto = {
      id: nextStepId("fix", draft.steps),
      kind: "fix",
      title: "Fix review findings",
      instructions: "Apply the accepted combined findings, rerun verification, and resolve reviewer follow-ups.",
      agentId: null,
      reuseStepId: null,
    };
    setDraft((current) => ({ ...current, steps: [...current.steps, step] }));
    setSelectedStepId(step.id);
  };
  const removeStep = (id: string) => {
    setDraft((current) => ({
      ...current,
      steps: sanitizeReuse(current.steps.filter((step) => step.id !== id)),
    }));
    const remaining = draft.steps.filter((step) => step.id !== id);
    setSelectedStepId(remaining[0]?.id);
  };
  const dragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    if (activeId.startsWith("palette:")) {
      const kind = activeId.slice("palette:".length);
      if (kind === "discuss" || kind === "review") addStep(kind);
      if (kind === "fix" && !fix) addFixStep();
      return;
    }
    if (!event.over || event.active.id === event.over.id) return;
    const next = moveWorkflowStep(draft.steps, activeId, String(event.over.id));
    if (next === draft.steps) {
      setError("Discussion and review cards can be reordered only inside their own phase.");
      return;
    }
    setDraft((current) => ({ ...current, steps: sanitizeReuse([...next]) }));
    setError(undefined);
  };

  const submit = async () => {
    const name = draft.name.trim();
    const steps = draft.steps.map((step) => ({
      ...step,
      title: step.title.trim(),
      instructions: step.instructions.trim(),
      reuseStepId: step.reuseStepId ?? null,
    }));
    if (!name || steps.some((step) => !step.title || !step.instructions)) {
      setError("Enter a name, title, and instruction for every step.");
      return;
    }
    setBusy(true); setError(undefined);
    try {
      const shared = {
        name,
        coordinatorAgentId: draft.coordinatorAgentId,
        model: props.configuration?.model ?? "default",
        permission: props.configuration?.permission ?? "acceptEdits",
        reasoning: props.configuration?.reasoning ?? "default",
        maxReviewCycles: draft.maxReviewCycles,
        steps,
        expectedRevision: props.stateRevision,
      };
      const result = await props.save(props.configuration
        ? { ...shared, workflowId: props.configuration.id }
        : { ...shared, projectId: props.projectId });
      if (typeof result === "string") { setError(result); return; }
      props.close();
    } finally { setBusy(false); }
  };

  const deleteWorkflow = async () => {
    if (!props.configuration) return;
    if (!confirmingDelete) { setConfirmingDelete(true); return; }
    setBusy(true); setError(undefined);
    try {
      const failure = await props.remove(props.configuration.id);
      if (failure) { setError(failure); setConfirmingDelete(false); return; }
      props.close();
    } finally { setBusy(false); }
  };

  return <section className="stage-editor workflow-editor-stage" aria-labelledby="workflow-editor-title" onKeyDown={(event) => event.key === "Escape" && props.close()}>
      <header className="stage-editor-head">
        <div className="stage-editor-title"><span>{props.configuration ? "Workflow template" : "New workflow template"}</span><h2 id="workflow-editor-title">{props.configuration?.name ?? "Discuss, implement, review"}</h2><code>Runs inside each Task worktree</code></div>
        <div className="stage-editor-actions">
          {props.configuration ? <button type="button" className="danger-button workflow-delete" disabled={busy} onClick={() => void deleteWorkflow()}>{confirmingDelete ? "Delete workflow" : "Delete"}</button> : null}
          <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Save template"}</button>
          <button className="icon-button quiet" aria-label="Close workflow editor" onClick={props.close}><Icon name="close" /></button>
        </div>
      </header>
      <div className="workflow-builder-body workflow-builder-stage-body">
        <div className="workflow-builder-top">
          <div><label htmlFor="workflow-name">Template name</label><input id="workflow-name" autoFocus value={draft.name} maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></div>
          <div><label htmlFor="workflow-coordinator">Coordinator</label><select id="workflow-coordinator" value={draft.coordinatorAgentId} onChange={(event) => setDraft((current) => ({ ...current, coordinatorAgentId: event.target.value as StewardAgentId }))}>{agents.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.available}>{agent.label}{agent.available ? "" : " (unavailable)"}</option>)}</select></div>
          <div><label htmlFor="workflow-review-cycles">Max review cycles</label><select id="workflow-review-cycles" value={draft.maxReviewCycles} onChange={(event) => setDraft((current) => ({ ...current, maxReviewCycles: Number(event.target.value) }))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></div>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
          <div className="workflow-builder-grid">
            <aside className="workflow-node-palette" aria-label="Workflow nodes">
              <div className="plan-head"><span className="plan-heading">Nodes</span><small className="plan-sub">Drag or click</small></div>
              <WorkflowPaletteItem kind="discuss" label="Discussion" disabled={draft.steps.length >= 8} add={() => addStep("discuss")} />
              <WorkflowPaletteItem kind="review" label="Reviewer" disabled={draft.steps.length >= 8} add={() => addStep("review")} />
              <WorkflowPaletteItem kind="fix" label="Fix loop" disabled={draft.steps.length >= 8 || Boolean(fix) || reviews.length === 0} add={addFixStep} />
              <p>Reviewers run independently. Core waits for every answer before Fix.</p>
            </aside>
            <section className="workflow-pipeline" aria-labelledby="workflow-pipeline-title">
              <div className="plan-head"><span className="plan-heading" id="workflow-pipeline-title">Canvas</span><small className="plan-sub">Core-managed route</small></div>
              <SortableContext items={draft.steps.map((step) => step.id)} strategy={verticalListSortingStrategy}>
                <div className="workflow-canvas" role="list" aria-label="Workflow canvas">
                  <WorkflowCoreNode label="Start" detail="Run goal enters here" />
                  {discussions.length ? <WorkflowCanvasStage label="Discuss in order" className="discussion-stage">
                    {discussions.map((step) => <SortableWorkflowStepCard
                      key={step.id}
                      step={step}
                      index={draft.steps.indexOf(step)}
                      selected={step.id === selectedStep?.id}
                      coordinatorAgentId={draft.coordinatorAgentId}
                      steps={draft.steps}
                      select={() => setSelectedStepId(step.id)}
                    />)}
                  </WorkflowCanvasStage> : null}
                  {implementation ? <SortableWorkflowStepCard
                    step={implementation}
                    index={draft.steps.indexOf(implementation)}
                    selected={implementation.id === selectedStep?.id}
                    coordinatorAgentId={draft.coordinatorAgentId}
                    steps={draft.steps}
                    select={() => setSelectedStepId(implementation.id)}
                  /> : null}
                  {reviews.length ? <>
                    <WorkflowCanvasStage label={`${reviews.length} parallel reviewer${reviews.length === 1 ? "" : "s"}`} className="review-stage">
                      {reviews.map((step) => <SortableWorkflowStepCard
                        key={step.id}
                        step={step}
                        index={draft.steps.indexOf(step)}
                        selected={step.id === selectedStep?.id}
                        coordinatorAgentId={draft.coordinatorAgentId}
                        steps={draft.steps}
                        select={() => setSelectedStepId(step.id)}
                      />)}
                    </WorkflowCanvasStage>
                    <WorkflowCoreNode label="Wait for all" detail="Core combines review outcomes" join />
                  </> : null}
                  {fix ? <SortableWorkflowStepCard
                    step={fix}
                    index={draft.steps.indexOf(fix)}
                    selected={fix.id === selectedStep?.id}
                    coordinatorAgentId={draft.coordinatorAgentId}
                    steps={draft.steps}
                    select={() => setSelectedStepId(fix.id)}
                  /> : null}
                  <WorkflowCoreNode label="Done" detail={fix ? "Approved or review limit reached" : "All steps completed"} />
                </div>
              </SortableContext>
            </section>
            <section className="workflow-inspector" aria-label="Selected workflow step">
              {selectedStep ? <WorkflowStepInspector
                step={selectedStep}
                steps={draft.steps}
                coordinatorAgentId={draft.coordinatorAgentId}
                agents={agents}
                remove={isHelperStep(selectedStep) ? () => removeStep(selectedStep.id) : undefined}
                update={(update) => updateStep(selectedStep.id, update)}
              /> : null}
            </section>
          </div>
        </DndContext>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
  </section>;
}

function WorkflowPaletteItem(props: {
  kind: "discuss" | "review" | "fix";
  label: string;
  disabled: boolean;
  add(): void;
}) {
  const draggable = useDraggable({ id: `palette:${props.kind}`, disabled: props.disabled });
  const style = { transform: CSS.Translate.toString(draggable.transform) };
  return <button
    ref={draggable.setNodeRef}
    style={style}
    type="button"
    className={`workflow-palette-node kind-${props.kind}${draggable.isDragging ? " dragging" : ""}`}
    disabled={props.disabled}
    onClick={props.add}
    {...draggable.attributes}
    {...draggable.listeners}
  >
    <span aria-hidden="true">+</span>
    <b>{props.label}</b>
    <small>{props.kind === "review" ? "Independent Agent" : props.kind === "fix" ? "Coordinator" : "Agent conversation"}</small>
  </button>;
}

function WorkflowCanvasStage(props: { label: string; className: string; children: ReactNode }) {
  return <section className={`workflow-canvas-stage ${props.className}`}>
    <header><span>{props.label}</span></header>
    <div>{props.children}</div>
  </section>;
}

function WorkflowCoreNode(props: { label: string; detail: string; join?: boolean | undefined }) {
  return <div className={`workflow-core-node${props.join ? " join" : ""}`} role="listitem">
    <span>{props.join ? "◇" : "●"}</span>
    <b>{props.label}</b>
    <small>{props.detail}</small>
  </div>;
}

function SortableWorkflowStepCard(props: {
  step: WorkflowStepDto;
  index: number;
  selected: boolean;
  coordinatorAgentId: StewardAgentId;
  steps: readonly WorkflowStepDto[];
  select(): void;
}) {
  const movable = isHelperStep(props.step);
  const sortable = useSortable({ id: props.step.id, disabled: !movable });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return <article
    ref={sortable.setNodeRef}
    style={style}
    className={`workflow-step-card kind-${props.step.kind}${props.selected ? " selected" : ""}${sortable.isDragging ? " dragging" : ""}`}
    role="listitem"
  >
    <button type="button" className="workflow-step-select" aria-pressed={props.selected} onClick={props.select}>
      <span className="workflow-step-number">{props.index + 1}</span>
      <span className="workflow-step-copy"><b>{props.step.title}</b><small>{stepOwnerSummary(props.step, props.steps, props.coordinatorAgentId)}</small></span>
      <span className={`workflow-kind kind-${props.step.kind}`}>{stepKindLabel(props.step.kind)}</span>
    </button>
    {movable ? <button
      type="button"
      className="workflow-drag-handle"
      aria-label={`Reorder ${props.step.title}`}
      title="Drag to reorder"
      {...sortable.attributes}
      {...sortable.listeners}
    ><Icon name="grip" /></button> : <span className="workflow-step-lock">fixed</span>}
  </article>;
}

function WorkflowStepInspector(props: {
  step: WorkflowStepDto;
  steps: readonly WorkflowStepDto[];
  coordinatorAgentId: StewardAgentId;
  agents: readonly WorkflowAgent[];
  remove?: (() => void) | undefined;
  update(update: Partial<WorkflowStepDto>): void;
}) {
  const priorHelpers = props.steps
    .slice(0, props.steps.findIndex((step) => step.id === props.step.id))
    .filter((step) => step.kind === "discuss");
  const reusedByAnotherReviewer = new Set(props.steps
    .filter((step) => step.kind === "review" && step.id !== props.step.id && step.reuseStepId)
    .map((step) => step.reuseStepId));
  const participantValue = props.step.reuseStepId
    ? `reuse:${props.step.reuseStepId}`
    : `fresh:${props.step.agentId ?? "claude"}`;
  const setParticipant = (value: string) => {
    if (value.startsWith("reuse:")) {
      const reused = priorHelpers.find((step) => step.id === value.slice("reuse:".length));
      if (reused?.agentId) props.update({ agentId: reused.agentId, reuseStepId: reused.id });
      return;
    }
    props.update({ agentId: value.slice("fresh:".length) as StewardAgentId, reuseStepId: null });
  };
  return <>
    <header className="workflow-inspector-head">
      <div><span className={`workflow-kind kind-${props.step.kind}`}>{stepKindLabel(props.step.kind)}</span><h3>{props.step.title}</h3></div>
      {props.remove ? <button type="button" className="icon-button quiet" aria-label={`Remove ${props.step.title}`} onClick={props.remove}><Icon name="trash" /></button> : null}
    </header>
    <div className="workflow-inspector-fields">
      <label htmlFor={`workflow-${props.step.id}-title`}>Step title</label>
      <input id={`workflow-${props.step.id}-title`} value={props.step.title} maxLength={120} onChange={(event) => props.update({ title: event.target.value })} />
      {isHelperStep(props.step) ? <>
        <label htmlFor={`workflow-${props.step.id}-participant`}>Agent conversation</label>
        <select id={`workflow-${props.step.id}-participant`} value={participantValue} onChange={(event) => setParticipant(event.target.value)}>
          {props.agents.map((agent) => <option key={`fresh:${agent.id}`} value={`fresh:${agent.id}`} disabled={!agent.available}>New {agent.label}{agent.available ? "" : " (unavailable)"}</option>)}
          {props.step.kind === "review" ? priorHelpers.map((step) => <option key={`reuse:${step.id}`} value={`reuse:${step.id}`} disabled={reusedByAnotherReviewer.has(step.id)}>Reuse {agentLabel(step.agentId)} from “{step.title}”{reusedByAnotherReviewer.has(step.id) ? " (already assigned)" : ""}</option>) : null}
        </select>
        <p className="field-help">{props.step.reuseStepId ? "Continues the same helper conversation and context." : "Starts a separate visible helper Session."}</p>
      </> : <div className="workflow-owned-step"><Icon name={props.coordinatorAgentId === "claude" ? "claude" : "codex"} /><span><b>{agentLabel(props.coordinatorAgentId)} coordinator</b><small>{props.step.kind === "fix" ? "Applies the combined review findings" : "Works in the Task worktree"}</small></span></div>}
      <label htmlFor={`workflow-${props.step.id}-instructions`}>Instructions</label>
      <textarea id={`workflow-${props.step.id}-instructions`} rows={7} value={props.step.instructions} maxLength={4096} onChange={(event) => props.update({ instructions: event.target.value })} />
    </div>
  </>;
}

type WorkflowAgent = { id: StewardAgentId; label: string; available: boolean };

function workflowAgents(capabilities: readonly AgentCapabilityDto[]): WorkflowAgent[] {
  const supported: StewardAgentId[] = ["codex", "claude"];
  return supported.map((id) => {
    const capability = capabilities.find((candidate) => candidate.agent_id === id);
    return { id, label: capability?.label ?? agentLabel(id), available: capability?.available ?? false };
  });
}

function workflowDraft(configuration?: WorkflowConfigurationDto): WorkflowDraft {
  if (configuration) return {
    name: configuration.name,
    coordinatorAgentId: configuration.coordinatorAgentId,
    maxReviewCycles: configuration.maxReviewCycles,
    steps: configuration.steps.map((step) => ({ ...step, reuseStepId: step.reuseStepId ?? null })),
  };
  return {
    name: "Discuss, implement, review",
    coordinatorAgentId: "codex",
    maxReviewCycles: 2,
    steps: initialWorkflowSteps(),
  };
}

export function initialWorkflowSteps(): WorkflowStepDto[] {
  return [
    { id: "discuss-claude", kind: "discuss", title: "Challenge the approach", instructions: "Debate the goal, assumptions, and tradeoffs with the coordinator before implementation.", agentId: "claude", reuseStepId: null },
    { id: "implement", kind: "implement", title: "Implement", instructions: "Implement the agreed solution and run proportionate verification.", agentId: null, reuseStepId: null },
    { id: "review-claude", kind: "review", title: "Review with prior context", instructions: "Review the current diff against the discussion and report concrete, prioritized findings.", agentId: "claude", reuseStepId: "discuss-claude" },
    { id: "review-codex", kind: "review", title: "Independent second review", instructions: "Independently inspect the current diff and report concrete, prioritized findings.", agentId: "codex", reuseStepId: null },
    { id: "fix", kind: "fix", title: "Fix review findings", instructions: "Apply the accepted combined findings, rerun verification, and resolve reviewer follow-ups.", agentId: null, reuseStepId: null },
  ];
}

function defaultStep(kind: "discuss" | "review", steps: readonly WorkflowStepDto[], agentId: StewardAgentId): WorkflowStepDto {
  return {
    id: nextStepId(kind, steps),
    kind,
    title: kind === "discuss" ? "Discuss" : "Review",
    instructions: kind === "discuss" ? "Challenge the current approach and surface tradeoffs." : "Review the current diff and report concrete findings.",
    agentId,
    reuseStepId: null,
  };
}

export function moveWorkflowStep(steps: readonly WorkflowStepDto[], activeId: string, overId: string): readonly WorkflowStepDto[] {
  const from = steps.findIndex((step) => step.id === activeId);
  const to = steps.findIndex((step) => step.id === overId);
  if (from < 0 || to < 0 || steps[from]?.kind !== steps[to]?.kind || !isHelperStep(steps[from]!)) return steps;
  return arrayMove([...steps], from, to);
}

function sanitizeReuse(steps: WorkflowStepDto[]): WorkflowStepDto[] {
  return steps.map((step, index) => {
    if (!step.reuseStepId) return step;
    const source = steps.slice(0, index).find((candidate) => candidate.id === step.reuseStepId);
    return source && isHelperStep(source) && source.agentId === step.agentId ? step : { ...step, reuseStepId: null };
  });
}

function isHelperStep(step: WorkflowStepDto): boolean {
  return step.kind === "discuss" || step.kind === "review";
}

export function nextStepId(kind: WorkflowStepKind, steps: readonly Pick<WorkflowStepDto, "id">[]): string {
  const ids = new Set(steps.map((step) => step.id));
  for (let index = 1; index <= 8; index += 1) {
    const candidate = `${kind}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${kind}-step`;
}

function stepKindLabel(kind: WorkflowStepKind): string {
  if (kind === "discuss") return "Discuss";
  if (kind === "review") return "Review";
  if (kind === "fix") return "Fix";
  return "Implement";
}

function agentLabel(agentId: string | null): string {
  if (agentId === "claude") return "Claude";
  if (agentId === "codex") return "Codex";
  return agentId ?? "Agent";
}

function stepOwnerSummary(step: WorkflowStepDto, steps: readonly WorkflowStepDto[], coordinatorAgentId: StewardAgentId): string {
  if (!isHelperStep(step)) return `${agentLabel(coordinatorAgentId)} · coordinator`;
  if (!step.reuseStepId) return `${agentLabel(step.agentId)} · new conversation`;
  const source = steps.find((candidate) => candidate.id === step.reuseStepId);
  return `${agentLabel(step.agentId)} · reuse ${source?.title ?? step.reuseStepId}`;
}

function workflowSummary(configuration: WorkflowConfigurationDto): string {
  return configuration.steps.map((step) => stepKindLabel(step.kind)).join(" → ");
}

function workflowExecutionSummary(execution: WorkflowExecution): string {
  if (execution.status === "completed") return `${execution.workflowName} completed`;
  const step = execution.steps[execution.currentStepIndex];
  return `${execution.workflowName}: ${step?.title ?? "in progress"} (${execution.currentStepIndex + 1}/${execution.steps.length})`;
}

function workflowStatusLabel(status: WorkflowExecution["status"]): string {
  if (status === "completed") return "Completed";
  if (status === "paused") return "Paused";
  return "Running";
}

function workflowPhaseLabel(execution: WorkflowExecution, step: WorkflowStepDto | undefined): string {
  if (execution.status === "completed") return "Core completed the workflow";
  if (execution.status === "paused") return "Coordinator stopped — resume its Session or stop this automation";
  const reviewCount = step?.kind === "review" ? activeReviewIndexes(execution).length : 0;
  if (execution.phase === "awaitingHelper" && reviewCount) return `Waiting for ${reviewCount} independent reviewer${reviewCount === 1 ? "" : "s"}`;
  if (execution.phase === "awaitingHelper") return `Waiting for ${agentLabel(step?.agentId ?? null)}`;
  if (execution.phase === "awaitingStepCompletion" && reviewCount) return `All ${reviewCount} review replies delivered — coordinator is recording outcomes`;
  if (execution.phase === "awaitingStepCompletion") return "Helper reply delivered — coordinator is deciding the outcome";
  if (step?.kind === "implement") return "Coordinator is implementing the agreed approach";
  if (step?.kind === "fix") return "Coordinator is applying the combined review findings";
  return "Coordinator is starting this step";
}

function workflowStepParticipant(step: WorkflowStepDto, steps: readonly WorkflowStepDto[]): string {
  if (!isHelperStep(step)) return "Coordinator";
  if (!step.reuseStepId) return `${agentLabel(step.agentId)} · new conversation`;
  const source = steps.find((candidate) => candidate.id === step.reuseStepId);
  return `${agentLabel(step.agentId)} · reuse “${source?.title ?? step.reuseStepId}”`;
}

function workflowStepResult(execution: WorkflowExecution, stepId: string): WorkflowStepResultDto | undefined {
  return execution.stepResults.find((result) => result.stepId === stepId);
}

function workflowStepState(
  execution: WorkflowExecution,
  index: number,
  result: WorkflowStepResultDto | undefined,
): "complete" | "current" | "upcoming" | "skipped" {
  if (execution.status === "completed") return result?.outcome === "skipped" ? "skipped" : "complete";
  if (activeReviewIndexes(execution).includes(index)) {
    return result?.reviewCycle === execution.reviewCycle ? "complete" : "current";
  }
  if (index === execution.currentStepIndex) return "current";
  if (index < execution.currentStepIndex) return result?.outcome === "skipped" ? "skipped" : "complete";
  return "upcoming";
}

function activeReviewIndexes(execution: WorkflowExecution): number[] {
  if (execution.steps[execution.currentStepIndex]?.kind !== "review") return [];
  const indexes: number[] = [];
  for (let index = execution.currentStepIndex; index < execution.steps.length; index += 1) {
    if (execution.steps[index]?.kind !== "review") break;
    indexes.push(index);
  }
  return indexes;
}

function workflowStepSessionId(execution: WorkflowExecution, step: WorkflowStepDto): string | undefined {
  if (!isHelperStep(step)) return execution.coordinatorSessionId;
  const participant = execution.participants.find((candidate) => candidate.stepId === step.id)
    ?? (step.reuseStepId
      ? execution.participants.find((candidate) => candidate.stepId === step.reuseStepId)
      : undefined);
  return participant?.sessionId;
}

function workflowStepResultLabel(
  kind: WorkflowStepKind,
  outcome: WorkflowStepResultDto["outcome"],
): string {
  if (outcome === "approved") return "Approved";
  if (outcome === "changesRequested") return "Changes requested";
  if (outcome === "skipped") return "Skipped";
  if (kind === "discuss") return "Decision";
  if (kind === "fix") return "Fixed";
  return "Completed";
}

export function workflowStepResultFileName(
  step: WorkflowStepDto,
  steps: readonly WorkflowStepDto[],
): string {
  if (step.kind === "discuss") return "decisions.md";
  if (step.kind === "implement") return "implementation.md";
  if (step.kind === "fix") return "fixes.md";
  const reviews = steps.filter((candidate) => candidate.kind === "review");
  if (reviews.length === 1) return "review.md";
  const suffix = step.id
    .toLowerCase()
    .replace(/^review-?/u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return `review-${suffix || reviews.indexOf(step) + 1}.md`;
}
