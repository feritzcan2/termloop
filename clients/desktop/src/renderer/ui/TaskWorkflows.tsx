import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
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
import { useEffect, useMemo, useState } from "react";
import type {
  AgentCapabilityDto,
  StewardAgentId,
  WorkflowConfigurationCreateParams,
  WorkflowConfigurationDto,
  WorkflowConfigurationUpdateParams,
  WorkflowStepDto,
  WorkflowStepKind,
} from "@termloop/contract/current";
import type { Task, WorkflowConfiguration, WorkflowExecution } from "../model.js";
import { Icon } from "./Icon.js";
import { OverlayPortal } from "./OverlayPortal.js";

export function TaskWorkflowLaunchers(props: {
  projectId: string;
  task: Task;
  configurations: readonly WorkflowConfiguration[];
  executions: readonly WorkflowExecution[];
  stateRevision: number;
  agentCapabilities: readonly AgentCapabilityDto[];
  launchable: boolean;
  overlayContainer: Element | undefined;
  overlayVisibilityChanged(visible: boolean): void;
  save(params: WorkflowConfigurationCreateParams | WorkflowConfigurationUpdateParams): Promise<WorkflowConfigurationDto | string>;
  remove(workflowId: string): Promise<string | undefined>;
  launch(taskId: string, workflowId: string, goal: string): Promise<string | undefined>;
  cancel(executionId: string): Promise<string | undefined>;
}) {
  const [editing, setEditing] = useState<WorkflowConfigurationDto | "new">();
  const [running, setRunning] = useState<WorkflowConfigurationDto>();
  const [inspectingExecution, setInspectingExecution] = useState(false);
  const execution = props.executions.find((candidate) => candidate.taskId === props.task.id);
  const executionActive = execution !== undefined && execution.status !== "completed";
  const { overlayVisibilityChanged } = props;
  useEffect(() => {
    overlayVisibilityChanged(Boolean(editing || running || (inspectingExecution && execution)));
    return () => overlayVisibilityChanged(false);
  }, [editing, execution, inspectingExecution, overlayVisibilityChanged, running]);

  return <>
    <span className="task-launch-divider" aria-hidden="true" />
    {execution ? <button
      type="button"
      className={`workflow-execution-chip status-${execution.status}`}
      title={workflowExecutionSummary(execution)}
      aria-label={`Open ${execution.workflowName} workflow progress`}
      onClick={() => setInspectingExecution(true)}
    >
      <span className="workflow-execution-dot" aria-hidden="true" />
      <Icon name="branch" />
      <span>{execution.workflowName}</span>
      <b>{execution.status === "completed" ? "Done" : `${Math.min(execution.currentStepIndex + 1, execution.steps.length)}/${execution.steps.length}`}</b>
    </button> : null}
    {props.configurations.map((configuration) => (
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
          onClick={() => setEditing(configuration)}
        ><Icon name="edit" /></button>
      </span>
    ))}
    <button
      type="button"
      className="workflow-add"
      title="Add workflow"
      aria-label="Add workflow"
      onClick={() => setEditing("new")}
    ><Icon name="add" />Workflow</button>
    <OverlayPortal container={props.overlayContainer}>
      {editing ? <WorkflowEditorDialog
        projectId={props.projectId}
        configuration={editing === "new" ? undefined : editing}
        stateRevision={props.stateRevision}
        agentCapabilities={props.agentCapabilities}
        close={() => setEditing(undefined)}
        save={props.save}
        remove={props.remove}
      /> : null}
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
      /> : null}
    </OverlayPortal>
  </>;
}

function WorkflowExecutionDialog(props: {
  execution: WorkflowExecution;
  close(): void;
  cancel(executionId: string): Promise<string | undefined>;
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
          {props.execution.steps.some((step) => step.kind === "review") && props.execution.status !== "completed"
            ? <small>Review cycle {props.execution.reviewCycle} of {props.execution.maxReviewCycles}</small>
            : null}
        </div>
        <ol className="workflow-progress-steps">
          {props.execution.steps.map((step, index) => {
            const state = props.execution.status === "completed" || index < props.execution.currentStepIndex
              ? "complete"
              : index === props.execution.currentStepIndex ? "current" : "upcoming";
            return <li key={step.id} className={`kind-${step.kind} ${state}`} aria-current={state === "current" ? "step" : undefined}>
              <span className="workflow-progress-marker">{state === "complete" ? "✓" : index + 1}</span>
              <span><b>{step.title}</b><small>{workflowStepParticipant(step, props.execution.steps)}</small></span>
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

export function WorkflowEditorDialog(props: {
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
  const implementationIndex = draft.steps.findIndex((step) => step.kind === "implement");

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
    if (!event.over || event.active.id === event.over.id) return;
    const next = moveWorkflowStep(draft.steps, String(event.active.id), String(event.over.id));
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

  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && props.close()}>
    <button className="dialog-backdrop" aria-label="Cancel workflow editing" onClick={props.close} />
    <section className="dialog-card workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title">
      <header className="dialog-header">
        <div><span className="dialog-eyebrow">{props.configuration ? "Workflow template" : "New workflow template"}</span><h2 id="workflow-dialog-title">{props.configuration?.name ?? "Discuss, implement, review"}</h2></div>
        <button className="icon-button quiet" aria-label="Close dialog" onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="dialog-body workflow-builder-body">
        <div className="workflow-builder-top">
          <div><label htmlFor="workflow-name">Template name</label><input id="workflow-name" autoFocus value={draft.name} maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></div>
          <div><label htmlFor="workflow-coordinator">Coordinator</label><select id="workflow-coordinator" value={draft.coordinatorAgentId} onChange={(event) => setDraft((current) => ({ ...current, coordinatorAgentId: event.target.value as StewardAgentId }))}>{agents.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.available}>{agent.label}{agent.available ? "" : " (unavailable)"}</option>)}</select></div>
          <div><label htmlFor="workflow-review-cycles">Max review cycles</label><select id="workflow-review-cycles" value={draft.maxReviewCycles} onChange={(event) => setDraft((current) => ({ ...current, maxReviewCycles: Number(event.target.value) }))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></div>
        </div>
        <div className="workflow-builder-grid">
          <section className="workflow-pipeline" aria-labelledby="workflow-pipeline-title">
            <div className="plan-head"><span className="plan-heading" id="workflow-pipeline-title">Flow</span><small className="plan-sub">Drag to reorder</small></div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
              <SortableContext items={draft.steps.map((step) => step.id)} strategy={verticalListSortingStrategy}>
                <div className="workflow-steps" role="list">
                  {draft.steps.map((step, index) => <SortableWorkflowStepCard
                    key={step.id}
                    step={step}
                    index={index}
                    selected={step.id === selectedStep?.id}
                    coordinatorAgentId={draft.coordinatorAgentId}
                    steps={draft.steps}
                    select={() => setSelectedStepId(step.id)}
                  />)}
                </div>
              </SortableContext>
            </DndContext>
            <div className="workflow-add-steps">
              <button type="button" className="secondary-button" disabled={draft.steps.length >= 8 || implementationIndex < 0} onClick={() => addStep("discuss")}><Icon name="add" />Discussion</button>
              <button type="button" className="secondary-button" disabled={draft.steps.length >= 8 || implementationIndex < 0} onClick={() => addStep("review")}><Icon name="add" />Review</button>
              {draft.steps.some((step) => step.kind === "fix") ? null : <button type="button" className="secondary-button" disabled={draft.steps.length >= 8 || !draft.steps.some((step) => step.kind === "review")} onClick={addFixStep}><Icon name="add" />Fix</button>}
            </div>
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
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions">
        {props.configuration ? <button type="button" className="danger-button workflow-delete" disabled={busy} onClick={() => void deleteWorkflow()}>{confirmingDelete ? "Delete workflow" : "Delete"}</button> : null}
        <button type="button" className="secondary-button" disabled={busy} onClick={props.close}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Save template"}</button>
      </footer>
    </section>
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
  const priorHelpers = props.steps.slice(0, props.steps.findIndex((step) => step.id === props.step.id)).filter(isHelperStep);
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
          {props.step.kind === "review" ? priorHelpers.map((step) => <option key={`reuse:${step.id}`} value={`reuse:${step.id}`}>Reuse {agentLabel(step.agentId)} from “{step.title}”</option>) : null}
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
  if (execution.phase === "awaitingHelper") return `Waiting for ${agentLabel(step?.agentId ?? null)}`;
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
