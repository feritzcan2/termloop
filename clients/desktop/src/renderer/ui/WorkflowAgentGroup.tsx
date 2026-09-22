import { useEffect, useId, useState, type ReactNode } from "react";
import type { Session } from "../model.js";
import type { WorkflowAgentGroup } from "./active-agent-workflows.js";
import { Icon } from "./Icon.js";

type WorkflowAgentSegment = {
  workflow: WorkflowAgentGroup | undefined;
  sessions: Session[];
};

/// Preserve the existing order and explicit detached/manual groups. Unrelated
/// helpers stay outside the workflow frame, even when they share its lead.
export function workflowAgentSegments(
  sessions: readonly Session[],
  groups: ReadonlyMap<string, WorkflowAgentGroup> | undefined,
): WorkflowAgentSegment[] {
  const segments: WorkflowAgentSegment[] = [];
  for (const session of sessions) {
    const workflow = groups?.get(session.id);
    const previous = segments.at(-1);
    if (previous && previous.workflow?.executionId === workflow?.executionId) previous.sessions.push(session);
    else segments.push({ workflow, sessions: [session] });
  }
  return segments;
}

export function WorkflowAgentGroupFrame({ workflow, metadata, children, close, disabled, revealMembers }: {
  workflow: WorkflowAgentGroup; metadata?: ReactNode; children: ReactNode;
  close?: (() => void) | undefined; disabled?: boolean | undefined; revealMembers?: boolean | undefined;
}) {
  const membersId = useId();
  const [collapsedExecutionId, setCollapsedExecutionId] = useState<string>();
  const expanded = collapsedExecutionId !== workflow.executionId;
  useEffect(() => { if (revealMembers) setCollapsedExecutionId(undefined); }, [revealMembers]);
  const closeAction = close ? <button type="button" className="workflow-agent-group-close" disabled={disabled}
    aria-label={`Close all agents in workflow ${workflow.name}`} title={disabled ? "Reconnect to close this workflow" : "Close this workflow and all its agents"}
    onClick={(event) => { event.stopPropagation(); close(); }}><Icon name="close" /></button> : null;
  return <div role="listitem">
    <section
      className={`workflow-agent-group status-${workflow.status}${workflow.needsAttention ? " needs-attention" : ""}`}
      role="group"
      aria-label={`Workflow · ${workflow.context}`}
      data-workflow-group={workflow.executionId}
    >
      <header className="workflow-agent-group-header" title={workflow.context}>
        <button type="button" className="workflow-agent-group-toggle"
          aria-label={`${expanded ? "Hide" : "Show"} agents in ${workflow.name}`}
          aria-expanded={expanded} aria-controls={membersId}
          onClick={() => setCollapsedExecutionId(expanded ? workflow.executionId : undefined)}>
          <span className="workflow-agent-group-title"><Icon name="branch" /><strong>{workflow.name}</strong></span>
          <span className="workflow-agent-group-status">{workflow.statusLabel}</span>
          <Icon name="chevronDown" className={`workflow-agent-group-disclosure${expanded ? " expanded" : ""}`} />
        </button>
        {closeAction}
      </header>
      {metadata ? <div className="workflow-agent-group-tools">{metadata}</div> : null}
      <div id={membersId} className="workflow-agent-group-members" role="list" hidden={!expanded}>{children}</div>
    </section>
  </div>;
}
