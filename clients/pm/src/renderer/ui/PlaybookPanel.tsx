import { useState } from "react";
import type { PmBoardTicket, PmPlaybook, PmPlaybookProposal, PmPlaybookStep } from "@termloop/pm-contract/pm";
import { NOT_STARTED, nextStep, ticketLabel } from "./format.js";
import { describeCheck } from "./PlaybookEditor.js";
import { PlaybookSetupDialog } from "./PlaybookSetupDialog.js";

export type PlaybookPanelProps = {
  playbook: PmPlaybook | undefined;
  proposal: PmPlaybookProposal | null;
  /** The shown sprint's tickets. */
  tickets: PmBoardTicket[];
  now: number;
  /** The project's code folder: the Playbook setup searches it. */
  repository: string | null;
  onOpenTicket(ticketId: string): void;
  onEdit(): void;
  onSetUp(): void;
  /** Resolves true once the reviewed steps are the project's Playbook. */
  onApplyProposal(steps: PmPlaybookStep[]): Promise<boolean>;
  onDiscardProposal(): void;
};

/** How a step passes, in one line: its fact checks, its agent, or the PM's mark. */
function passesBy(step: PmPlaybookStep): string {
  const ways = step.checks.map(describeCheck);
  if (step.agent) ways.push("an agent checks");
  return ways.length > 0 ? ways.join(" · ") : "You mark it";
}

/**
 * The right sidebar's "Playbook" view: the project's steps top to bottom,
 * how each one passes, how many of the shown sprint's tickets stand at it,
 * and the tickets an agent found waiting or blocked on it.
 */
export function PlaybookPanel(props: PlaybookPanelProps) {
  const [reviewing, setReviewing] = useState(false);
  const { playbook, proposal } = props;
  if (!playbook) return <div className="playbook-panel"><p className="hint pad">Loading the Playbook…</p></div>;
  const standing = (position: number | null) => props.tickets.filter((entry) => entry.delivery.playbook.position === position).length;
  const stuck = (step: PmPlaybookStep) => props.tickets.flatMap((entry) => {
    const next = nextStep(playbook, entry.delivery);
    const verdict = next?.step.id === step.id ? next.state?.verdict : undefined;
    return verdict === "waiting" || verdict === "blocked" ? [{ entry, verdict, evidence: next!.state!.evidence }] : [];
  });
  const review = proposal && (
    <PlaybookSetupDialog
      key={proposal.createdAtEpochMs}
      proposal={proposal}
      now={props.now}
      onApply={props.onApplyProposal}
      onDiscard={props.onDiscardProposal}
      onClose={() => setReviewing(false)}
    />
  );
  // Revision 0 is never shown as steps: the project has no Playbook until an agent created one.
  if (playbook.revision === 0) {
    return (
      <div className="playbook-panel">
        <div className="playbook-empty">
          <b>No Playbook yet</b>
          {proposal ? (
            <>
              <p className="hint">The agent proposed {proposal.steps.length} steps. Review them, change what you like, and save.</p>
              <button type="button" className="btn pri" onClick={() => setReviewing(true)}>Review proposal</button>
            </>
          ) : (
            <>
              <p className="hint">An agent reads the project's repository — its pipelines, deploy files and history — and proposes the steps a ticket walks here, asking you only what it cannot find.</p>
              <button type="button" className="btn pri" onClick={props.onSetUp}>{props.repository === null ? "Choose repository…" : "Create with the agent"}</button>
            </>
          )}
        </div>
        {reviewing && review}
      </div>
    );
  }
  return (
    <div className="playbook-panel">
      <div className="right-sidebar-tools">
        <span className="meta">{playbook.steps.length} steps</span>
        <span className="sp" />
        <button type="button" className="btn sm ghost" onClick={props.onEdit}>Edit</button>
        {proposal
          ? <button type="button" className="btn sm pri" onClick={() => setReviewing(true)}>Review proposal</button>
          : <button type="button" className="btn sm" title="An agent reads the repository again and proposes changes" onClick={props.onSetUp}>Improve with the agent</button>}
      </div>
      <ol className="playbook-rail" aria-label="Playbook steps">
        <li className="playbook-rail-step start">
          <div className="playbook-rail-head"><b>{NOT_STARTED}</b><span className="n">{standing(null)}</span></div>
        </li>
        {playbook.steps.map((step, index) => {
          const waiting = stuck(step);
          return (
            <li key={step.id} className={`playbook-rail-step ${step.agent ? "agent" : ""}`}>
              <div className="playbook-rail-head">
                <b>{step.title}</b>
                {step.agent && <span className="chip-static">agent</span>}
                <span className="sp" />
                <span className="n" title="Tickets that passed this step last">{standing(index)}</span>
              </div>
              <p className="playbook-rail-how">{passesBy(step)}</p>
              {waiting.length > 0 && (
                <ul className="playbook-rail-waiting">
                  {waiting.map(({ entry, verdict, evidence }) => (
                    <li key={entry.ticket.id}>
                      <button type="button" className="link" title={evidence ?? undefined} onClick={() => props.onOpenTicket(entry.ticket.id)}>
                        <span className={verdict === "blocked" ? "bad" : "warn"}>{verdict}</span> {ticketLabel(entry.ticket)} {entry.ticket.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {reviewing && review}
    </div>
  );
}
