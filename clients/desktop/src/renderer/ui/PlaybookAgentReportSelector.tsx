import { useEffect, useState } from "react";
import type { PlaybookAgentReportPolicy, PlaybookGateKind } from "@termloop/contract/current";

import {
  PLAYBOOK_AGENT_REPORT_POLICIES,
  playbookAgentReportDescription,
  playbookAgentReportLabel,
} from "./playbook-policy.js";
import "./playbook-check.css";

/** How one Playbook step treats the Task Agent's own report that its work
    reached the step. A human gate waits on its approver, so it never trusts
    one. */
export function PlaybookAgentReportSelector({
  gate,
  agentReport,
  busy,
  save,
}: {
  gate: PlaybookGateKind;
  agentReport: PlaybookAgentReportPolicy;
  busy: boolean;
  save(agentReport: PlaybookAgentReportPolicy): Promise<void>;
}) {
  const human = gate === "human";
  const [choice, setChoice] = useState(agentReport);
  useEffect(() => { setChoice(agentReport); }, [agentReport]);
  return <div className="ap-section ap-step-check">
    <span className="ap-label">When the Task Agent reports this step</span>
    <div className="ap-step-check-fields">
      <label>Report
        <select aria-label="Task Agent report" value={choice} disabled={busy}
          onChange={(event) => setChoice(event.target.value as PlaybookAgentReportPolicy)}>
          {PLAYBOOK_AGENT_REPORT_POLICIES.map((policy) => <option key={policy} value={policy}
            disabled={human && policy === "trusted"}>{playbookAgentReportLabel(policy)}</option>)}
        </select>
      </label>
      <button type="button" className="ap-btn primary"
        disabled={busy || choice === agentReport || (human && choice === "trusted")}
        onClick={() => void save(choice)}>Save</button>
    </div>
    <p className="ap-hint">{playbookAgentReportDescription(choice)}{human && choice !== "off"
      ? " Its approver still decides the gate."
      : ""}</p>
  </div>;
}
