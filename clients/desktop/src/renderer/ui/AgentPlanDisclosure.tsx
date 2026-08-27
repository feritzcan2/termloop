import type { AgentStatus, Session } from "../model.js";

export function AgentPlanDisclosure({ session, status, selected, expanded, setExpanded, showWorkspace = false, nested = false }: {
  session: Session;
  status: AgentStatus | undefined;
  selected: boolean;
  expanded?: boolean;
  setExpanded?(expanded: boolean): void;
  showWorkspace?: boolean;
  nested?: boolean;
}) {
  const plan = planLifecycleIsVisible(session) ? status?.plan : undefined;
  const hasPlan = Boolean(plan && plan.steps.length > 0);
  const completed = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const done = hasPlan && completed === plan!.steps.length;
  if ((!hasPlan && !expanded) || (done && !selected && !expanded)) return null;
  const current = plan?.steps.find((step) => step.status === "inProgress")
    ?? plan?.steps.find((step) => step.status === "pending")
    ?? plan?.steps[plan.steps.length - 1];
  const controlled = expanded !== undefined;
  return (
    <details
      className={`agent-plan${nested ? " nested" : ""}${done ? " done" : ""}`}
      {...(controlled ? { open: expanded } : {})}
      onToggle={setExpanded ? (event) => setExpanded(event.currentTarget.open) : undefined}
    >
      <summary title={current?.text ?? "Agent details"}>
        {hasPlan ? <>
          <span className="agent-plan-count">{completed}/{plan!.steps.length}</span>
          <span className="agent-plan-current">{current?.text}</span>
        </> : <>
          <span className="agent-plan-label">Details</span>
        </>}
      </summary>
      <dl className="agent-detail-facts">
        {showWorkspace ? <div><dt>Workspace</dt><dd title={session.process.cwd}>{session.process.cwd}</dd></div> : null}
        <div><dt>Session</dt><dd title={session.id}>{session.id}</dd></div>
      </dl>
      {plan?.explanation ? <p>{plan.explanation}</p> : null}
      {hasPlan ? <ol>
        {plan!.steps.map((step, index) => (
          <li key={`${index}:${step.text}`} data-status={step.status}>
            <span className="agent-plan-mark" aria-hidden="true" />
            <span>{step.text}</span>
          </li>
        ))}
      </ol> : null}
    </details>
  );
}

function planLifecycleIsVisible(session: Session): boolean {
  return session.lifecycle_state === "running" || session.lifecycle_state === "resuming";
}
