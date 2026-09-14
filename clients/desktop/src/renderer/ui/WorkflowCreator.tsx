import { useEffect, useRef, useState } from "react";
import type { SessionDto, WorkflowCreatorDraftGetResult, WorkflowProposal, WorkflowTemplateDraft } from "@termloop/contract/current";
import type { QuickActionAgentSelection } from "../quick-action-memory.js";
import { Icon } from "./Icon.js";
import { agentLabel, stepKindLabel, workflowLaunchSummary } from "./workflow-presentation.js";

export type WorkflowCreatorTarget = { workflowId: string | null; taskId: string | null; draft: WorkflowTemplateDraft | null };
export type WorkflowCreatorActions = {
  start(projectId: string, target: WorkflowCreatorTarget, selection?: QuickActionAgentSelection, options?: { fresh?: boolean }): Promise<string | undefined>;
  read(projectId: string, workflowId: string | null): Promise<WorkflowCreatorDraftGetResult>;
};

export function workflowCreatorSession(sessions: readonly SessionDto[], projectId: string, workflowId: string | null): SessionDto | undefined {
  return [...sessions].reverse().find((session) => session.project_id === projectId
    && session.improver_target?.targetKind === "workflowDraft"
    && session.improver_target.targetId === workflowId);
}

export function WorkflowCreator(props: {
  projectId: string;
  workflowId: string | null;
  generation: number | undefined;
  actions: WorkflowCreatorActions;
  session: SessionDto | undefined;
  busy: boolean;
  unavailableReason: string | undefined;
  dirty: boolean;
  start(): void;
  continue(): void;
  useDraft(proposal: WorkflowProposal): void;
}) {
  const [result, setResult] = useState<WorkflowCreatorDraftGetResult>();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [confirmVersion, setConfirmVersion] = useState<string>();
  const [usedVersion, setUsedVersion] = useState<string>();
  const actions = useRef(props.actions);
  actions.current = props.actions;
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || disposed || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const next = await actions.current.read(props.projectId, props.workflowId);
        if (!disposed) { setResult(next); setError(undefined); }
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { pending = false; }
    };
    void refresh();
    // Watch only a mounted editor with an exact creator Session; never stack requests.
    const interval = props.session ? window.setInterval(() => void refresh(), 2_000) : undefined;
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { disposed = true; if (interval !== undefined) window.clearInterval(interval);
      window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [props.projectId, props.workflowId, props.session?.id]);

  const proposal = result?.proposal;
  const stale = proposal && proposal.sourceGeneration !== (props.generation ?? null);
  const apply = () => {
    if (!proposal || !result?.versionId || stale || props.busy) return;
    if (props.dirty && confirmVersion !== result.versionId) { setConfirmVersion(result.versionId); return; }
    props.useDraft(proposal); setUsedVersion(result.versionId); setConfirmVersion(undefined);
  };
  return <aside className="workflow-creator" aria-label="Workflow Creator">
    <div className="workflow-creator-bar">
      <span className="workflow-creator-copy"><strong><Icon name="sparkles" />Workflow Creator</strong>
        <small>{props.session ? "Discuss changes in the creator conversation. Review its proposal here before saving." : "Describe what you need. Get a reusable flow you can review and edit."}</small></span>
      {props.session ? <button type="button" className="secondary-button" disabled={props.busy || Boolean(props.unavailableReason)} onClick={props.continue}>Continue creator</button> : null}
      <button type="button" className="secondary-button" disabled={props.busy || Boolean(props.unavailableReason)} title={props.unavailableReason}
        onClick={props.start}>{props.session ? "Creator settings" : props.workflowId ? "Edit with AI" : "Create with AI"}</button>
      {proposal ? <button type="button" className="secondary-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {usedVersion === result.versionId ? "AI draft applied" : "Review AI draft"}</button> : null}
    </div>
    {props.unavailableReason ? <p className="workflow-creator-note">{props.unavailableReason}</p> : null}
    {error ? <p role="alert" className="form-error">Could not load the AI draft: {error}</p> : null}
    {expanded && proposal ? <section className="workflow-creator-preview" aria-label="AI draft preview">
      <div><strong>{proposal.workflow.name}</strong><p>{result?.summary || "Proposed workflow — not saved"}</p>
        <small>Lead · {agentLabel(proposal.workflow.coordinatorAgentId)} · {workflowLaunchSummary(proposal.workflow)}</small></div>
      <ol>{proposal.workflow.steps.map((step) => <li key={step.id}><strong>{step.title}</strong><small>{stepKindLabel(step.kind)} · {step.agentId ? agentLabel(step.agentId) : "Lead agent"}{step.reuseStepId ? " · Reused conversation" : step.model && step.permission && step.reasoning ? ` · ${workflowLaunchSummary({ model: step.model, permission: step.permission, reasoning: step.reasoning })}` : ""}</small></li>)}</ol>
      {proposal.workflow.permission === "bypassPermissions" || proposal.workflow.steps.some((step) => step.permission === "bypassPermissions")
        ? <p className="form-error">This proposal includes bypass permissions. Review those agent settings before saving.</p> : null}
      <p className="workflow-creator-note">Using this draft updates only the editor. Review instructions and permissions, then save explicitly. Nothing starts automatically.</p>
      {stale ? <p role="alert" className="form-error">This proposal is based on another saved version. Keep your current edits and start a fresh creator from the current template.</p> : null}
      {confirmVersion === result?.versionId ? <p role="alert">Replace your unsaved editor changes with this AI draft?</p> : null}
      <div className="workflow-creator-actions">
        <button type="button" className="primary-button" disabled={props.busy || Boolean(stale) || usedVersion === result?.versionId} onClick={apply}>{confirmVersion === result?.versionId ? "Replace editor draft" : "Use AI draft"}</button>
        {confirmVersion ? <button type="button" className="secondary-button" onClick={() => setConfirmVersion(undefined)}>Keep my edits</button> : null}
      </div>
    </section> : null}
  </aside>;
}
