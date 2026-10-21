import { useEffect, useState } from "react";
import type {
  PlaybookDeterministicCheckDto,
  PlaybookDeterministicCheckKind,
  PlaybookGateKind,
} from "@termloop/contract/current";

import {
  PLAYBOOK_BASE_BRANCH_MAX_BYTES,
  PLAYBOOK_CHECK_KINDS,
  playbookCheckDescription,
  playbookCheckKindLabel,
  utf8ByteLength,
} from "./playbook-policy.js";
import "./playbook-check.css";

const ROUTINE = "routine";
type CheckChoice = PlaybookDeterministicCheckKind | typeof ROUTINE;

function sameCheck(left: PlaybookDeterministicCheckDto | null, right: PlaybookDeterministicCheckDto | null): boolean {
  return left === right || (left !== null && right !== null && left.kind === right.kind && left.baseBranch === right.baseBranch);
}

/** How one Playbook step decides it is complete: by its agent Routine, or
    directly from the Task branch's pull request. A human gate waits on a
    person, so it offers no check at all. */
export function PlaybookCheckSelector({
  gate,
  check,
  busy,
  save,
}: {
  gate: PlaybookGateKind;
  check: PlaybookDeterministicCheckDto | null;
  busy: boolean;
  save(check: PlaybookDeterministicCheckDto | null): Promise<void>;
}) {
  const human = gate === "human";
  const [choice, setChoice] = useState<CheckChoice>(check?.kind ?? ROUTINE);
  const [baseBranch, setBaseBranch] = useState(check?.baseBranch ?? "");
  useEffect(() => {
    setChoice(human ? ROUTINE : check?.kind ?? ROUTINE);
    setBaseBranch(check?.baseBranch ?? "");
  }, [human, check?.kind, check?.baseBranch]);
  const trimmedBase = baseBranch.trim();
  const next: PlaybookDeterministicCheckDto | null = human || choice === ROUTINE
    ? null
    : { kind: choice, baseBranch: trimmedBase === "" ? null : trimmedBase };
  const baseTooLong = utf8ByteLength(trimmedBase) > PLAYBOOK_BASE_BRANCH_MAX_BYTES;
  const baseHasSpace = /\s/u.test(trimmedBase);
  const changed = !sameCheck(next, check);
  return <div className="ap-section ap-step-check">
    <span className="ap-label">How is completion checked?</span>
    <div className="ap-step-check-fields">
      <label>Check
        <select aria-label="Completion check" value={human ? ROUTINE : choice} disabled={busy || human}
          onChange={(event) => setChoice(event.target.value as CheckChoice)}>
          <option value={ROUTINE}>Agent routine (LLM)</option>
          {PLAYBOOK_CHECK_KINDS.map((kind) => <option key={kind} value={kind}>{playbookCheckKindLabel(kind)}</option>)}
        </select>
      </label>
      {!human && choice !== ROUTINE ? <label>Base branch
        <input aria-label="Pull request base branch" value={baseBranch} disabled={busy}
          placeholder="Any branch" spellCheck={false}
          onChange={(event) => setBaseBranch(event.target.value)} />
      </label> : null}
      <button type="button" className="ap-btn primary" disabled={busy || human || !changed || baseTooLong || baseHasSpace}
        onClick={() => void save(next)}>Save check</button>
    </div>
    <p className="ap-hint">{human
      ? "Human gates wait for their approver, so they cannot use a pull request check."
      : next
        ? `${playbookCheckDescription(next)} TermLoop reads the pull request directly; if the provider cannot answer, the agent Routine decides instead.`
        : "The agent Routine checks the completion rule above with the verification instructions below."}</p>
    {baseTooLong ? <p className="ap-problem">Base branch is too long (max {PLAYBOOK_BASE_BRANCH_MAX_BYTES} bytes).</p> : null}
    {baseHasSpace ? <p className="ap-problem">Base branch cannot contain spaces.</p> : null}
  </div>;
}
