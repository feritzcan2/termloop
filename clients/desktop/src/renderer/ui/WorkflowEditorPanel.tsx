import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentCapabilityDto, AgentLibraryEntry, AssistantPermission, StewardAgentId, WorkflowConfigurationCreateParams, WorkflowConfigurationDto, WorkflowConfigurationUpdateParams, WorkflowStepDto } from "@termloop/contract/current";
import { Icon } from "./Icon.js";
import { WorkflowAgentTemplateSelect } from "./WorkflowAgentTemplateSelect.js";
import { isHelperStep, nextStepId, stepKindLabel, agentLabel, stepOwnerSummary, workflowLaunchSummary, workflowModelLabel, workflowPermissionLabel, workflowReasoningLabel, selectionOptions, type WorkflowLaunchSelection, type WorkflowReasoning } from "./workflow-presentation.js";

type WorkflowDraft = {
  name: string;
  coordinatorAgentId: StewardAgentId;
  model: string;
  permission: AssistantPermission;
  reasoning: WorkflowReasoning;
  maxReviewCycles: number;
  steps: WorkflowStepDto[];
};

export type WorkflowEditorDraft = {
  value: WorkflowDraft;
  baseline: WorkflowDraft;
  generation: number | undefined;
};

export function WorkflowEditorPanel(props: {
  projectId: string;
  configuration?: WorkflowConfigurationDto | undefined;
  stateRevision: number;
  agentCapabilities: readonly AgentCapabilityDto[];
  agentProfiles: readonly AgentLibraryEntry[];
  initialDraft?: WorkflowEditorDraft | undefined;
  draftChanged?(draft: WorkflowEditorDraft | undefined): void;
  close(): void;
  save(params: WorkflowConfigurationCreateParams | WorkflowConfigurationUpdateParams): Promise<WorkflowConfigurationDto | string>;
  remove(workflowId: string): Promise<string | undefined>;
}) {
  const agents = useMemo(() => workflowAgents(props.agentCapabilities), [props.agentCapabilities]);
  const [draft, setDraft] = useState<WorkflowDraft>(() => props.initialDraft?.value ?? workflowDraft(props.configuration));
  const [baseline, setBaseline] = useState(() => props.initialDraft?.baseline ?? workflowDraft(props.configuration));
  const [generation, setGeneration] = useState(() => props.initialDraft?.generation ?? props.configuration?.generation);
  const [selectedStepId, setSelectedStepId] = useState(() => draft.steps[0]?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const flowHeadingRef = useRef<HTMLSpanElement>(null);
  const selectStep = (id: string) => {
    setSelectedStepId(id);
    requestAnimationFrame(() => {
      const inspector = inspectorRef.current;
      if (inspector && (inspector.parentElement?.clientWidth ?? 0) <= 760) {
        inspector.scrollIntoView?.({ block: "start", behavior: "smooth" });
      }
    });
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const selectedStep = draft.steps.find((step) => step.id === selectedStepId) ?? draft.steps[0];
  const discussions = draft.steps.filter((step) => step.kind === "discuss");
  const implementation = draft.steps.find((step) => step.kind === "implement");
  const reviews = draft.steps.filter((step) => step.kind === "review");
  const fix = draft.steps.find((step) => step.kind === "fix");
  const coordinatorAgent = workflowAgent(draft.coordinatorAgentId, agents);
  const dirty = !props.configuration || JSON.stringify(draft) !== JSON.stringify(baseline);
  const { draftChanged } = props;
  useEffect(() => {
    draftChanged?.(dirty ? { value: draft, baseline, generation } : undefined);
  }, [draft, baseline, generation, dirty, draftChanged]);
  const close = () => {
    if (busy) return;
    if (dirty) setConfirmingClose(true);
    else props.close();
  };
  const discard = () => {
    props.draftChanged?.(undefined);
    props.close();
  };

  const updateStep = (id: string, update: Partial<WorkflowStepDto>) => {
    setDraft((current) => ({
      ...current,
      steps: sanitizeReuse(current.steps.map((step) => step.id === id ? { ...step, ...update } : step)),
    }));
    setConfirmingDelete(false);
  };
  const addStep = (kind: "discuss" | "review") => {
    if (busy || draft.steps.length >= 8) return;
    const helperAgentId: StewardAgentId = kind === "discuss" ? "claude" : "codex";
    const step = {
      ...defaultStep(kind, draft.steps, helperAgentId),
      ...workflowLaunchDefaults(workflowAgent(helperAgentId, agents)),
    };
    setDraft((current) => {
      const implementAt = current.steps.findIndex((candidate) => candidate.kind === "implement");
      const fixAt = current.steps.findIndex((candidate) => candidate.kind === "fix");
      const insertAt = kind === "discuss" ? implementAt : (fixAt < 0 ? current.steps.length : fixAt);
      const steps = [...current.steps];
      steps.splice(insertAt, 0, step);
      return { ...current, steps };
    });
    selectStep(step.id);
  };
  const addFixStep = () => {
    if (busy || fix || !reviews.length || draft.steps.length >= 8) return;
    const step: WorkflowStepDto = {
      id: nextStepId("fix", draft.steps),
      kind: "fix",
      title: "Fix review findings",
      instructions: "Apply the accepted combined findings, rerun verification, and resolve reviewer follow-ups.",
      agentId: null,
      reuseStepId: null,
      profileRef: null,
      model: null,
      permission: null,
      reasoning: null,
    };
    setDraft((current) => ({ ...current, steps: [...current.steps, step] }));
    selectStep(step.id);
  };
  const removeStep = (id: string) => {
    if (busy || draft.steps.find((step) => step.id === id)?.kind === "implement") return;
    const remaining = removeWorkflowStep(draft.steps, id);
    setDraft((current) => ({
      ...current,
      steps: remaining,
    }));
    setSelectedStepId(remaining[0]?.id);
    if (fix && !remaining.some((step) => step.kind === "fix") && id !== fix.id) {
      setError("The fix step was removed too: it needs at least one reviewer. Add a reviewer to enable it again.");
    }
  };
  const dragEnd = (event: DragEndEvent) => {
    if (busy) return;
    const activeId = String(event.active.id);
    if (activeId.startsWith("palette:")) {
      const overId = event.over ? String(event.over.id) : undefined;
      if (!overId || (overId !== "workflow-canvas-drop" && !draft.steps.some((step) => step.id === overId))) return;
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
    if (busy) return;
    if (props.configuration?.generation !== generation) {
      setError("This template changed elsewhere. Your draft is preserved. Load the saved version to review its changes before editing again.");
      return;
    }
    const name = draft.name.trim();
    const steps = draft.steps.map((step) => ({
      ...step,
      title: step.title.trim(),
      instructions: step.instructions.trim(),
      reuseStepId: step.reuseStepId ?? null,
      profileRef: step.profileRef ?? null,
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
        model: draft.model,
        permission: draft.permission,
        reasoning: draft.reasoning,
        maxReviewCycles: draft.maxReviewCycles,
        steps,
        expectedRevision: props.stateRevision,
      };
      const result = await props.save(props.configuration
        ? { ...shared, workflowId: props.configuration.id }
        : { ...shared, projectId: props.projectId });
      if (typeof result === "string") { setError(result); return; }
      discard();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const deleteWorkflow = async () => {
    if (!props.configuration) return;
    if (!confirmingDelete) { setConfirmingDelete(true); return; }
    setBusy(true); setError(undefined);
    try {
      const failure = await props.remove(props.configuration.id);
      if (failure) { setError(failure); setConfirmingDelete(false); return; }
      discard();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return <section className="stage-editor workflow-editor-stage" aria-labelledby="workflow-editor-title" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
    if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); void submit(); }
  }}>
      <header className="stage-editor-head">
        <div className="stage-editor-title"><span>{props.configuration ? "Workflow template" : "New workflow template"}</span><h2 id="workflow-editor-title">{draft.name || "Untitled workflow"}</h2><code>Reusable in every Task in this Project</code></div>
        <div className="stage-editor-actions">
          {dirty ? <span className="workflow-unsaved">{props.configuration ? "Unsaved changes" : "New template"}</span> : null}
          {props.configuration ? <button type="button" className="danger-button workflow-delete" disabled={busy} onClick={() => void deleteWorkflow()}>{confirmingDelete ? "Delete workflow" : "Delete"}</button> : null}
          <button type="button" className="primary-button" disabled={busy || !dirty} onClick={() => void submit()}>{busy ? "Saving…" : "Save template"}</button>
          <button className="icon-button quiet" aria-label="Close workflow editor" disabled={busy} onClick={close}><Icon name="close" /></button>
        </div>
      </header>
      {confirmingClose ? <div className="workflow-draft-notice" role="alert">
        <span>Discard your unsaved changes?</span>
        <button type="button" className="secondary-button" onClick={() => setConfirmingClose(false)}>Keep editing</button>
        <button type="button" className="danger-button" onClick={discard}>Discard changes</button>
      </div> : null}
      {props.configuration?.generation !== generation ? <div className="workflow-draft-notice" role="alert">
        <span>This template changed elsewhere. Loading it replaces your unsaved draft.</span>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => {
          const next = workflowDraft(props.configuration);
          setDraft(next); setBaseline(next); setGeneration(props.configuration?.generation);
          setConfirmingClose(false); setError(undefined);
        }}>Load saved version</button>
      </div> : null}
      <fieldset className="workflow-builder-body workflow-builder-stage-body" disabled={busy}>
        <div className="workflow-builder-top">
          <div><label htmlFor="workflow-name">Template name</label><input id="workflow-name" autoFocus value={draft.name} maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></div>
          <div><label htmlFor="workflow-coordinator">Lead agent</label><select id="workflow-coordinator" value={draft.coordinatorAgentId} onChange={(event) => {
            const coordinatorAgentId = event.target.value as StewardAgentId;
            const defaults = workflowLaunchDefaults(workflowAgent(coordinatorAgentId, agents));
            setDraft((current) => ({ ...current, coordinatorAgentId, ...defaults }));
          }}>{agents.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.available}>{agent.label}{agent.available ? "" : " (unavailable)"}</option>)}</select></div>
        </div>
        <details className="workflow-advanced">
          <summary>Lead agent settings & review limit <span>{workflowPermissionLabel(draft.permission)} · up to {draft.maxReviewCycles} review rounds</span></summary>
          <div className="workflow-advanced-fields">
          <div><label htmlFor="workflow-coordinator-model">Model</label><select id="workflow-coordinator-model" aria-label="Coordinator Model" value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}>{selectionOptions(coordinatorAgent.models, draft.model).map((model) => <option key={model} value={model}>{workflowModelLabel(model)}</option>)}</select></div>
          <div><label htmlFor="workflow-coordinator-permission">Permission</label><select id="workflow-coordinator-permission" aria-label="Coordinator Permission" value={draft.permission} onChange={(event) => setDraft((current) => ({ ...current, permission: event.target.value as AssistantPermission }))}>{selectionOptions(coordinatorAgent.permissions, draft.permission).map((permission) => <option key={permission} value={permission}>{workflowPermissionLabel(permission)}</option>)}</select></div>
          <div><label htmlFor="workflow-coordinator-reasoning">Thinking</label><select id="workflow-coordinator-reasoning" aria-label="Coordinator Thinking" value={draft.reasoning} onChange={(event) => setDraft((current) => ({ ...current, reasoning: event.target.value as WorkflowReasoning }))}>{selectionOptions(coordinatorAgent.reasoning, draft.reasoning).map((reasoning) => <option key={reasoning} value={reasoning}>{workflowReasoningLabel(reasoning)}</option>)}</select></div>
          <div><label htmlFor="workflow-review-cycles">Maximum review rounds</label><select id="workflow-review-cycles" value={draft.maxReviewCycles} onChange={(event) => setDraft((current) => ({ ...current, maxReviewCycles: Number(event.target.value) }))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></div>
          </div>
        </details>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
            <aside className="workflow-node-palette" aria-label="Add workflow steps">
              <div className="plan-head"><span className="plan-heading">Add step</span><small className="plan-sub">{draft.steps.length}/8</small></div>
              <WorkflowPaletteItem kind="discuss" label="Discussion" disabled={draft.steps.length >= 8} add={() => addStep("discuss")} />
              <WorkflowPaletteItem kind="review" label="Reviewer" disabled={draft.steps.length >= 8} add={() => addStep("review")} />
              <WorkflowPaletteItem kind="fix" label="Fix loop" disabled={draft.steps.length >= 8 || Boolean(fix) || reviews.length === 0} add={addFixStep} />
              <p>Click to add, or drag into the flow. Reviewers run together.</p>
            </aside>
          <div className="workflow-builder-grid">
            <WorkflowPipeline>
              <div className="plan-head"><span ref={flowHeadingRef} className="plan-heading" id="workflow-pipeline-title">Workflow steps</span><small className="plan-sub">Top to bottom · drag a handle to reorder within a phase</small></div>
              <SortableContext items={draft.steps.map((step) => step.id)} strategy={verticalListSortingStrategy}>
                <div className="workflow-canvas" role="list" aria-label="Workflow flow">
                  <WorkflowCoreNode label="Start" detail="Run goal enters here" />
                  {discussions.length ? <WorkflowCanvasStage label="Discuss in order" className="discussion-stage">
                    {discussions.map((step) => <SortableWorkflowStepCard
                      key={step.id}
                      step={step}
                      index={draft.steps.indexOf(step)}
                      selected={step.id === selectedStep?.id}
                      coordinatorAgentId={draft.coordinatorAgentId}
                      steps={draft.steps}
                      agentProfiles={props.agentProfiles}
                      select={() => selectStep(step.id)}
                    />)}
                  </WorkflowCanvasStage> : null}
                  {implementation ? <SortableWorkflowStepCard
                    step={implementation}
                    index={draft.steps.indexOf(implementation)}
                    selected={implementation.id === selectedStep?.id}
                    coordinatorAgentId={draft.coordinatorAgentId}
                    steps={draft.steps}
                    agentProfiles={props.agentProfiles}
                    select={() => selectStep(implementation.id)}
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
                        agentProfiles={props.agentProfiles}
                        select={() => selectStep(step.id)}
                      />)}
                    </WorkflowCanvasStage>
                    <WorkflowCoreNode label="Collect all reviews" detail={fix ? "All approved → finish. Changes requested → fix below." : "Finish with the reviewers’ findings. No automatic fixes."} join />
                  </> : null}
                  {fix ? <SortableWorkflowStepCard
                    step={fix}
                    index={draft.steps.indexOf(fix)}
                    selected={fix.id === selectedStep?.id}
                    coordinatorAgentId={draft.coordinatorAgentId}
                    steps={draft.steps}
                    agentProfiles={props.agentProfiles}
                    select={() => selectStep(fix.id)}
                  /> : null}
                  {fix ? <div className="workflow-loop-note" role="listitem"><b>↳ Fixes go back to all reviewers</b><span>Up to {draft.maxReviewCycles} review round{draft.maxReviewCycles === 1 ? "" : "s"}. At the limit, the last fixes finish without another approval.</span></div> : null}
                  <WorkflowCoreNode label="Finish" detail={fix ? "Approved, or stopped at the review limit without approval" : "All steps completed"} />
                </div>
              </SortableContext>
            </WorkflowPipeline>
            <section ref={inspectorRef} className="workflow-inspector" aria-label="Selected workflow step">
              <button type="button" className="workflow-back-to-steps secondary-button" onClick={() => flowHeadingRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>↑ Back to steps</button>
              {selectedStep ? <WorkflowStepInspector
                step={selectedStep}
                steps={draft.steps}
                coordinatorAgentId={draft.coordinatorAgentId}
                coordinatorSelection={{ model: draft.model, permission: draft.permission, reasoning: draft.reasoning }}
                agents={agents}
                agentProfiles={props.agentProfiles}
                remove={selectedStep.kind !== "implement" ? () => removeStep(selectedStep.id) : undefined}
                update={(update) => updateStep(selectedStep.id, update)}
              /> : null}
            </section>
          </div>
        </DndContext>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </fieldset>
  </section>;
}

function WorkflowPipeline({ children }: { children: ReactNode }) {
  const drop = useDroppable({ id: "workflow-canvas-drop" });
  return <section ref={drop.setNodeRef} className={`workflow-pipeline${drop.isOver ? " drop-target" : ""}`} aria-labelledby="workflow-pipeline-title">{children}</section>;
}

export function removeWorkflowStep(steps: readonly WorkflowStepDto[], id: string): WorkflowStepDto[] {
  if (steps.find((step) => step.id === id)?.kind === "implement") return [...steps];
  const remaining = steps.filter((step) => step.id !== id);
  return sanitizeReuse(remaining.some((step) => step.kind === "review")
    ? remaining
    : remaining.filter((step) => step.kind !== "fix"));
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
    <small>{props.kind === "review" ? "Independent reviewer" : props.kind === "fix" ? "Lead agent" : "Agent conversation"}</small>
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
  agentProfiles: readonly AgentLibraryEntry[];
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
      <span className="workflow-step-copy"><b>{props.step.title}</b><small>{stepOwnerSummary(props.step, props.steps, props.coordinatorAgentId, props.agentProfiles)}</small></span>
      <span className={`workflow-kind kind-${props.step.kind}`}>{stepKindLabel(props.step.kind)}</span>
    </button>
    {movable ? <button
      type="button"
      className="workflow-drag-handle"
      aria-label={`Reorder ${props.step.title}`}
      title="Drag to reorder"
      {...sortable.attributes}
      {...sortable.listeners}
    ><Icon name="grip" /></button> : <span className="workflow-step-lock">{props.step.kind === "implement" ? "required" : "optional"}</span>}
  </article>;
}

function WorkflowStepInspector(props: {
  step: WorkflowStepDto;
  steps: readonly WorkflowStepDto[];
  coordinatorAgentId: StewardAgentId;
  coordinatorSelection: WorkflowLaunchSelection;
  agents: readonly WorkflowAgent[];
  agentProfiles: readonly AgentLibraryEntry[];
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
  const selectedAgent = workflowAgent((props.step.agentId ?? "claude") as StewardAgentId, props.agents);
  const selectedProfile = props.agentProfiles.find((profile) => profile.id === props.step.profileRef);
  const setParticipant = (value: string) => {
    if (value.startsWith("reuse:")) {
      const reused = priorHelpers.find((step) => step.id === value.slice("reuse:".length));
      if (reused?.agentId) props.update({
        agentId: reused.agentId,
        reuseStepId: reused.id,
        profileRef: null,
        model: null,
        permission: null,
        reasoning: null,
      });
      return;
    }
    const agentId = value.slice("fresh:".length) as StewardAgentId;
    const agent = workflowAgent(agentId, props.agents);
    const profile = selectedProfile?.agent_ids.includes(agentId) ? selectedProfile : undefined;
    props.update({
      agentId,
      reuseStepId: null,
      profileRef: profile?.id ?? null,
      ...(profile ? workflowProfileLaunchSelection(profile, agent) : workflowLaunchDefaults(agent)),
    });
  };
  const selectProfile = (profileRef: string | null) => {
    if (!profileRef) { props.update({ profileRef: null }); return; }
    const profile = props.agentProfiles.find((candidate) => candidate.id === profileRef && candidate.user_invocable);
    if (!profile) return;
    const currentAgent = props.step.agentId
      ? workflowAgent(props.step.agentId, props.agents)
      : undefined;
    const agent = (currentAgent?.available && profile.agent_ids.includes(currentAgent.id) ? currentAgent : undefined)
      ?? props.agents.find((candidate) => candidate.id === profile.default_agent_id
      && candidate.available
      && profile.agent_ids.includes(candidate.id))
      ?? props.agents.find((candidate) => candidate.available && profile.agent_ids.includes(candidate.id));
    if (!agent) return;
    props.update({
      agentId: agent.id,
      reuseStepId: null,
      profileRef: profile.id,
      ...workflowProfileLaunchSelection(profile, agent),
    });
  };
  return <>
    <header className="workflow-inspector-head">
      <div><span className={`workflow-kind kind-${props.step.kind}`}>{stepKindLabel(props.step.kind)}</span><h3>{props.step.title}</h3></div>
      {props.remove ? <button type="button" className="icon-button quiet" aria-label={`Remove ${props.step.title}`} onClick={props.remove}><Icon name="trash" /></button> : null}
    </header>
    <div className="workflow-inspector-fields">
      <label htmlFor={`workflow-${props.step.id}-title`}>Step title</label>
      <input id={`workflow-${props.step.id}-title`} value={props.step.title} maxLength={120} onChange={(event) => props.update({ title: event.target.value })} />
      <label htmlFor={`workflow-${props.step.id}-instructions`}>Instructions</label>
      <textarea id={`workflow-${props.step.id}-instructions`} rows={5} value={props.step.instructions} maxLength={4096} onChange={(event) => props.update({ instructions: event.target.value })} />
      {isHelperStep(props.step) ? <>
        <label htmlFor={`workflow-${props.step.id}-participant`}>Agent conversation</label>
        <select id={`workflow-${props.step.id}-participant`} value={participantValue} onChange={(event) => setParticipant(event.target.value)}>
          {props.agents.map((agent) => <option key={`fresh:${agent.id}`} value={`fresh:${agent.id}`} disabled={!agent.available}>New {agent.label}{agent.available ? "" : " (unavailable)"}</option>)}
          {props.step.kind === "review" ? priorHelpers.map((step) => <option key={`reuse:${step.id}`} value={`reuse:${step.id}`} disabled={reusedByAnotherReviewer.has(step.id)}>Continue {agentLabel(step.agentId)} from “{step.title}”{reusedByAnotherReviewer.has(step.id) ? " (already assigned)" : ""}</option>) : null}
        </select>
        <p className="field-help">{props.step.reuseStepId ? "Continues the earlier conversation with its context and settings." : "Starts a separate agent conversation, visible in this Task."}</p>
        {props.step.reuseStepId ? <div className="workflow-inherited-launch"><Icon name="link" /><span><b>Agent and launch settings inherited</b><small>Uses the template, model, permission, and thinking from the original {agentLabel(props.step.agentId)} Session.</small></span></div> : <>
          <WorkflowAgentTemplateSelect
            id={`workflow-${props.step.id}-profile`}
            profiles={props.agentProfiles}
            agentId={(props.step.agentId ?? "claude") as StewardAgentId}
            value={props.step.profileRef}
            select={selectProfile}
          />
          <details className="workflow-advanced workflow-step-advanced">
          <summary>Model, permissions & thinking</summary>
          <div className="workflow-step-launch-fields">
          <label htmlFor={`workflow-${props.step.id}-model`}>Model<select id={`workflow-${props.step.id}-model`} aria-label="Step Model" value={props.step.model ?? "default"} onChange={(event) => props.update({ model: event.target.value })}>{selectionOptions(selectedAgent.models, props.step.model ?? "default").map((model) => <option key={model} value={model}>{workflowModelLabel(model)}</option>)}</select></label>
          <label htmlFor={`workflow-${props.step.id}-permission`}>Permission<select id={`workflow-${props.step.id}-permission`} aria-label="Step Permission" value={props.step.permission ?? "bypassPermissions"} onChange={(event) => props.update({ permission: event.target.value as AssistantPermission })}>{selectionOptions(selectedAgent.permissions, props.step.permission ?? "bypassPermissions").map((permission) => <option key={permission} value={permission}>{workflowPermissionLabel(permission)}</option>)}</select></label>
          <label htmlFor={`workflow-${props.step.id}-reasoning`}>Thinking<select id={`workflow-${props.step.id}-reasoning`} aria-label="Step Thinking" value={props.step.reasoning ?? "default"} onChange={(event) => props.update({ reasoning: event.target.value as WorkflowReasoning })}>{selectionOptions(selectedAgent.reasoning, props.step.reasoning ?? "default").map((reasoning) => <option key={reasoning} value={reasoning}>{workflowReasoningLabel(reasoning)}</option>)}</select></label>
          </div>
          </details>
        </>}
      </> : <div className="workflow-owned-step"><Icon name={props.coordinatorAgentId === "claude" ? "claude" : "codex"} /><span><b>{agentLabel(props.coordinatorAgentId)} lead agent</b><small>{props.step.kind === "fix" ? "Applies the combined review findings" : "Works in the Task worktree"} · {workflowLaunchSummary(props.coordinatorSelection)}</small></span></div>}
    </div>
  </>;
}

type WorkflowAgent = {
  id: StewardAgentId;
  label: string;
  available: boolean;
  models: readonly string[];
  permissions: readonly AssistantPermission[];
  reasoning: readonly WorkflowReasoning[];
};

function workflowAgents(capabilities: readonly AgentCapabilityDto[]): WorkflowAgent[] {
  const supported: StewardAgentId[] = ["codex", "claude"];
  return supported.map((id) => {
    const capability = capabilities.find((candidate) => candidate.agent_id === id);
    return {
      id,
      label: capability?.label ?? agentLabel(id),
      available: capability?.available ?? false,
      models: capability?.models.length ? capability.models : ["default"],
      permissions: capability?.permissions.length ? capability.permissions : ["default", "bypassPermissions"],
      reasoning: capability?.reasoning.length ? capability.reasoning : ["default"],
    };
  });
}

function workflowAgent(agentId: StewardAgentId, agents: readonly WorkflowAgent[]): WorkflowAgent {
  return agents.find((agent) => agent.id === agentId) ?? {
    id: agentId,
    label: agentLabel(agentId),
    available: false,
    models: ["default"],
    permissions: ["default", "bypassPermissions"],
    reasoning: ["default"],
  };
}

function workflowLaunchDefaults(agent: WorkflowAgent): WorkflowLaunchSelection {
  return {
    model: agent.models.includes("default") ? "default" : agent.models[0] ?? "default",
    permission: agent.permissions.includes("bypassPermissions")
      ? "bypassPermissions"
      : agent.permissions.includes("default") ? "default" : agent.permissions[0] ?? "default",
    reasoning: agent.reasoning.includes("default") ? "default" : agent.reasoning[0] ?? "default",
  };
}

function workflowProfileLaunchSelection(
  profile: AgentLibraryEntry,
  agent: WorkflowAgent,
): WorkflowLaunchSelection {
  return {
    model: agent.models.includes(profile.default_model)
      ? profile.default_model
      : agent.models.includes("default") ? "default" : agent.models[0] ?? "default",
    permission: agent.permissions.includes(profile.permission)
      ? profile.permission
      : agent.permissions.includes("default") ? "default" : agent.permissions[0] ?? "default",
    reasoning: agent.reasoning.includes(profile.default_reasoning)
      ? profile.default_reasoning
      : agent.reasoning.includes("default") ? "default" : agent.reasoning[0] ?? "default",
  };
}

function workflowDraft(configuration?: WorkflowConfigurationDto): WorkflowDraft {
  if (configuration) return {
    name: configuration.name,
    coordinatorAgentId: configuration.coordinatorAgentId,
    model: configuration.model,
    permission: configuration.permission,
    reasoning: configuration.reasoning,
    maxReviewCycles: configuration.maxReviewCycles,
    steps: configuration.steps.map((step) => ({
      ...step,
      reuseStepId: step.reuseStepId ?? null,
      profileRef: step.profileRef ?? null,
    })),
  };
  return {
    name: "Discuss, implement, review",
    coordinatorAgentId: "codex",
    model: "default",
    permission: "bypassPermissions",
    reasoning: "default",
    maxReviewCycles: 2,
    steps: initialWorkflowSteps(),
  };
}

export function initialWorkflowSteps(): WorkflowStepDto[] {
  return [
    { id: "discuss-claude", kind: "discuss", title: "Challenge the approach", instructions: "Debate the goal, assumptions, and tradeoffs with the coordinator before implementation.", agentId: "claude", reuseStepId: null, profileRef: null, model: "default", permission: "bypassPermissions", reasoning: "default" },
    { id: "implement", kind: "implement", title: "Implement", instructions: "Implement the agreed solution and run proportionate verification.", agentId: null, reuseStepId: null, profileRef: null, model: null, permission: null, reasoning: null },
    { id: "review-claude", kind: "review", title: "Review with prior context", instructions: "Review the current diff against the discussion and report concrete, prioritized findings.", agentId: "claude", reuseStepId: "discuss-claude", profileRef: null, model: null, permission: null, reasoning: null },
    { id: "review-codex", kind: "review", title: "Independent second review", instructions: "Independently inspect the current diff and report concrete, prioritized findings.", agentId: "codex", reuseStepId: null, profileRef: null, model: "default", permission: "bypassPermissions", reasoning: "default" },
    { id: "fix", kind: "fix", title: "Fix review findings", instructions: "Apply the accepted combined findings, rerun verification, and resolve reviewer follow-ups.", agentId: null, reuseStepId: null, profileRef: null, model: null, permission: null, reasoning: null },
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
    profileRef: null,
    model: "default",
    permission: "bypassPermissions",
    reasoning: "default",
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
    return source && isHelperStep(source) && source.agentId === step.agentId
      ? { ...step, profileRef: null }
      : { ...step, reuseStepId: null, profileRef: null, model: "default", permission: "bypassPermissions", reasoning: "default" };
  });
}
