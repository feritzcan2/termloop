import { agentName, type AgentStatus, type Session, type WorkflowExecution } from "../model.js";
import { sessionState } from "../session-presentation.js";
import { Icon } from "./Icon.js";
import { workflowStepSessionId } from "./workflow-presentation.js";

/** Live Session activity is independent of whether workflow automation has finished. */
export function TaskWorkflowActivity(props: {
  execution: WorkflowExecution;
  sessionsById: ReadonlyMap<string, Session>;
  statusesById: ReadonlyMap<string, AgentStatus>;
  reviewReadySessionIds: ReadonlySet<string>;
  openSession(sessionId: string): void;
}) {
  const { execution } = props;
  const sessionIds = new Set([execution.coordinatorSessionId, ...execution.participants.map((participant) => participant.sessionId)]);
  const working = [...sessionIds].flatMap((sessionId) => {
    const session = props.sessionsById.get(sessionId);
    if (!session || session.kind !== "Agent" || session.project_id !== execution.projectId || session.archived_at_epoch_ms !== null) return [];
    const state = sessionState(session, props.statusesById.get(sessionId), props.reviewReadySessionIds.has(sessionId));
    if (state.tone !== "working") return [];
    const currentStep = execution.steps[execution.currentStepIndex];
    const step = currentStep && workflowStepSessionId(execution, currentStep) === sessionId
      ? currentStep : [...execution.steps].reverse().find((candidate) => workflowStepSessionId(execution, candidate) === sessionId);
    const role = sessionId === execution.coordinatorSessionId ? "Lead agent" : step?.title ?? "Workflow agent";
    return [{ sessionId, name: agentName(session), state: state.label, role }];
  });
  if (!working.length) return null;
  return <section className="task-workflow-activity" aria-label={`${execution.workflowName} workflow agent activity`}>
    {working.length > 1 ? <strong className="task-workflow-activity-count">{working.length} workflow agents active</strong> : null}
    {working.map((agent) => <button
      key={agent.sessionId}
      type="button"
      className="task-workflow-active-agent"
      aria-label={`Open ${agent.name} — ${agent.state} · ${agent.role} · ${execution.workflowName}`}
      onClick={() => props.openSession(agent.sessionId)}
    >
      <i aria-hidden="true" />
      <span><strong>{agent.name} · {agent.state}</strong><small>Workflow · {execution.workflowName} · {agent.role}</small></span>
      <Icon name="arrowRight" />
    </button>)}
    {execution.status === "completed" ? <p>Automation finished; {working.length === 1 ? "agent is" : "agents are"} still active.</p> : null}
  </section>;
}
