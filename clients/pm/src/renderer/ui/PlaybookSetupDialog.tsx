import { useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { PmPlaybookProposal, PmPlaybookStep } from "@termloop/pm-contract/pm";
import { relativeTime } from "./format.js";
import { PlaybookStepsEditor, stepsProblem, tidySteps } from "./PlaybookEditor.js";

/**
 * What the Playbook setup found, reviewed in one place: the steps a ticket
 * walks in this project, each with the facts or agent that pass it. The PM
 * edits what to keep; nothing changes before Save. It is opened from the
 * sidebar but mounted on the body, so it covers the window like the app's
 * other dialogs.
 */
export function PlaybookSetupDialog(props: {
  proposal: PmPlaybookProposal;
  now: number;
  /** Resolves true once saved. */
  onApply(steps: PmPlaybookStep[]): Promise<boolean>;
  onDiscard(): void;
  onClose(): void;
}) {
  const { proposal } = props;
  const [steps, setSteps] = useState(proposal.steps);
  const [applying, setApplying] = useState(false);
  const problem = stepsProblem(steps);
  const apply = async () => {
    setApplying(true);
    const applied = await props.onApply(tidySteps(steps));
    setApplying(false);
    if (applied) props.onClose();
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    props.onClose();
  };
  return createPortal(
    <div className="modal-backdrop" onKeyDown={keys} onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="modal playbook-setup" role="dialog" aria-modal="true" aria-label="Set up the Playbook">
        <div className="modal-head">
          <b>Set up the Playbook</b>
          <span className="meta">found {relativeTime(proposal.createdAtEpochMs, props.now)}</span>
          <span className="sp" />
          <button type="button" className="icb" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        <p className="playbook-summary">{proposal.summary}</p>
        <PlaybookStepsEditor steps={steps} onChange={setSteps} />
        <div className="modal-foot">
          <span className="hint">{problem ?? `${steps.length} step(s), ${steps.filter((step) => step.agent).length} checked by an agent.`}</span>
          <span className="sp" />
          <button type="button" className="btn sm ghost" onClick={() => { props.onDiscard(); props.onClose(); }}>Discard</button>
          <button type="button" className="btn sm pri" disabled={problem !== undefined || applying} onClick={() => void apply()}>
            Save Playbook
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
