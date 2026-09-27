import { useEffect, useId, useState, type ReactNode } from "react";
import type { WorkflowAgentGroup } from "./active-agent-workflows.js";
import { Icon } from "./Icon.js";

/// A workflow run is one rail entry. Its agents stay folded until the user
/// opens it, search is open, or one of them is the selected Session, so a run
/// costs one row instead of a frame of agents plus metadata lines.
export function WorkflowAgentGroupFrame({ workflow, details, attention = false, containsSelection = false, children, close, disabled, revealMembers }: {
  workflow: WorkflowAgentGroup;
  details?: ReactNode;
  /// An agent in this run is waiting on the user or was interrupted.
  attention?: boolean | undefined;
  containsSelection?: boolean | undefined;
  children: ReactNode;
  close?: (() => void) | undefined;
  disabled?: boolean | undefined;
  revealMembers?: boolean | undefined;
}) {
  const membersId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (revealMembers) setExpanded(true); }, [revealMembers]);
  useEffect(() => { if (containsSelection) setExpanded(true); }, [containsSelection]);
  const closeAction = close ? <button type="button" className="workflow-agent-group-close" disabled={disabled}
    aria-label={`Close all agents in workflow ${workflow.name}`} title={disabled ? "Reconnect to close this workflow" : "Close this workflow and all its agents"}
    onClick={(event) => { event.stopPropagation(); close(); }}><Icon name="close" /></button> : null;
  return <div role="listitem">
    <section
      className={`workflow-agent-group status-${workflow.status}${workflow.needsAttention ? " needs-attention" : ""}${attention ? " members-need-attention" : ""}${expanded ? " expanded" : ""}`}
      role="group"
      aria-label={`Workflow · ${workflow.context}`}
      data-workflow-group={workflow.executionId}
    >
      <header className="workflow-agent-group-header" title={workflow.context}>
        <button type="button" className="workflow-agent-group-toggle"
          aria-label={`${expanded ? "Hide" : "Show"} agents in ${workflow.name}${attention ? ", an agent needs you" : ""}`}
          aria-expanded={expanded} aria-controls={membersId}
          onClick={() => setExpanded(!expanded)}>
          <Icon name="chevronDown" className={`workflow-agent-group-disclosure${expanded ? " expanded" : ""}`} />
          <span className="workflow-agent-group-title"><strong>{workflow.name}</strong></span>
          {attention ? <span className="workflow-agent-group-attention" aria-hidden="true" /> : null}
          <span className="workflow-agent-group-status">{workflow.statusLabel}</span>
        </button>
        {closeAction}
      </header>
      {details ? <div className="workflow-agent-group-tools">{details}</div> : null}
      <div id={membersId} className="workflow-agent-group-members" role="list" hidden={!expanded}>{children}</div>
    </section>
  </div>;
}
