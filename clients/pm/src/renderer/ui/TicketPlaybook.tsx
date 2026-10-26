import type { PmPlaybook, PmStepEvaluator, PmStepState, PmTicketDelivery } from "@termloop/pm-contract/pm";
import { nextStep, relativeTime, timeUntil } from "./format.js";

export type TicketPlaybookProps = {
  playbook: PmPlaybook;
  delivery: PmTicketDelivery;
  now: number;
  /** Starts an agent on the step the ticket works toward. */
  onCheck(): void;
  /** The PM's own answer: passed, or cleared so the step is looked at again. */
  onMark(stepId: string, passed: boolean): void;
};

const EVALUATOR_LABEL: Record<PmStepEvaluator, string> = { facts: "Facts", agent: "Agent", projectManager: "You" };

/** One step's line under its title: who answered, what they saw, and when. */
function stepDetail(state: PmStepState | undefined, now: number): string | undefined {
  if (!state) return undefined;
  if (state.implied) return "Passed: a later step passed.";
  if (!state.verdict || !state.evaluator) return undefined;
  const when = state.decidedAtEpochMs === null ? "" : ` · ${relativeTime(state.decidedAtEpochMs, now)}`;
  const again = state.nextAttemptAtEpochMs !== null && state.nextAttemptAtEpochMs > now ? ` · looks again ${timeUntil(state.nextAttemptAtEpochMs, now)}` : "";
  return `${EVALUATOR_LABEL[state.evaluator]}${state.evidence ? `: ${state.evidence}` : ""}${when}${again}`;
}

/**
 * The ticket on its project's Playbook: every step with what answered it.
 * The step it works toward can be checked by its agent now; any step can be
 * marked passed by hand, and the PM's or an agent's answer cleared.
 */
export function TicketPlaybook({ playbook, delivery, now, onCheck, onMark }: TicketPlaybookProps) {
  const next = nextStep(playbook, delivery);
  const passedCount = delivery.playbook.position === null ? 0 : delivery.playbook.position + 1;
  return (
    <section aria-label="Playbook">
      <h3 className="s">Playbook <small>{passedCount} of {playbook.steps.length} steps</small></h3>
      <ol className="ticket-steps">
        {playbook.steps.map((step, index) => {
          const state = delivery.playbook.steps[index];
          const passed = state?.verdict === "passed" || state?.implied === true;
          const tone = passed ? "passed" : state?.verdict ?? "open";
          const isNext = next?.step.id === step.id;
          // Facts re-derive on every read; only a stored answer can be cleared.
          const clearable = !state?.implied && state?.verdict !== null && state?.verdict !== undefined && state.evaluator !== "facts";
          const detail = stepDetail(state, now);
          return (
            <li key={step.id} className={`ticket-step ${tone} ${isNext ? "next" : ""}`}>
              <div className="ticket-step-head">
                <b>{step.title}</b>
                {step.agent && <span className="chip-static">agent</span>}
                <span className="sp" />
                {isNext && step.agent && (
                  <button type="button" className="btn sm ghost" disabled={delivery.checking} onClick={onCheck}>
                    {delivery.checking ? "Checking…" : "Check now"}
                  </button>
                )}
                {!passed && <button type="button" className="btn sm ghost" onClick={() => onMark(step.id, true)}>Mark passed</button>}
                {clearable && <button type="button" className="link" onClick={() => onMark(step.id, false)}>Clear</button>}
              </div>
              {detail && <p className="ticket-step-detail">{detail}</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
