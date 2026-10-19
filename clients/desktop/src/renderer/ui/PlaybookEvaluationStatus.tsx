import type { PlaybookEvaluationDto } from "@termloop/contract/current";
import type { Session } from "../model.js";
import "./playbook-evaluation.css";

const waitingReason: Record<NonNullable<PlaybookEvaluationDto["reason"]>, string> = {
  noUnambiguousTaskAgent: "No task agent could be selected unambiguously.",
  forkUnsupported: "The task agent does not support conversation forks.",
  forkUnavailable: "The task agent fork could not start.",
  evaluatorUnavailable: "The evaluator could not start.",
  evaluationCapacity: "All task evaluation slots are busy.",
};

export function PlaybookEvaluationStatus(props: {
  evaluation: PlaybookEvaluationDto;
  sessions: readonly Session[];
  openAgentTerminal(sessionId: string): void;
}) {
  const { evaluation } = props;
  const source = props.sessions.find((session) => session.id === evaluation.sourceSessionId);
  const executor = props.sessions.find((session) => session.id === evaluation.sessionId);
  const running = evaluation.mode === "taskAgentFork" || evaluation.mode === "freshEvaluator";
  const canOpen = executor?.lifecycle_state === "running" && running;
  const waiting = evaluation.mode === "waitingForTaskAgent";
  const label = evaluation.mode === "starting" ? "Starting task review"
    : waiting ? "Waiting · Task agent"
    : evaluation.mode === "freshEvaluator" ? "Checking · Evaluator" : "Checking · Task agent";
  const title = "Open task agent evaluation terminal";
  return <div className="ar-playbook-evaluation" data-evaluation-mode={evaluation.mode} role="status">
    {canOpen ? <button type="button" className="ar-evaluation-open" aria-label={title} title={title}
      onClick={() => props.openAgentTerminal(executor.id)}>
      <span className="ar-evaluation-pip" aria-hidden="true" />{label}<span aria-hidden="true">↗</span>
    </button> : <span className="ar-evaluation-label">{label}</span>}
    {waiting ? <small>{evaluation.reason ? waitingReason[evaluation.reason] : "Task agent review is unavailable."} No check was performed.</small>
      : <small>{source ? `Source: ${source.name ?? source.process.agent_id ?? "Task agent"}`
        : evaluation.mode === "starting" ? "Selecting and starting the task evaluator."
        : evaluation.mode === "freshEvaluator" ? "Read-only fresh evaluation. The task has no agent to fork."
        : "Read-only task agent evaluation."}</small>}
    {running && !canOpen ? <small>Connecting to the evaluation terminal…</small> : null}
  </div>;
}
