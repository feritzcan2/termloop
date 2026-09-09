import type { ReactNode } from "react";
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

export function WorkflowAgentGroupFrame({ workflow, children }: { workflow: WorkflowAgentGroup; children: ReactNode }) {
  return <div role="listitem">
    <section
      className={`workflow-agent-group status-${workflow.status}${workflow.needsAttention ? " needs-attention" : ""}`}
      role="group"
      aria-label={`Workflow · ${workflow.context}`}
      data-workflow-group={workflow.executionId}
    >
      <header className="workflow-agent-group-header" title={workflow.context}>
        <span className="workflow-agent-group-title"><Icon name="branch" /><small>Workflow</small><strong>{workflow.name}</strong></span>
        <span className="workflow-agent-group-status">{workflow.statusLabel}</span>
      </header>
      <div className="workflow-agent-group-members" role="list">{children}</div>
    </section>
  </div>;
}
