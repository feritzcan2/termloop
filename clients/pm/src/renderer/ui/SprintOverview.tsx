import { useState } from "react";
import type { PmBoardTicket, PmDataTier, PmDigestEntry, PmSprint } from "@termloop/pm-contract/pm";
import { RISK_LABEL, STAGE_LABEL, daysLeft, relativeTime, ticketLabel, unknownDeployment } from "./format.js";

export type SprintOverviewProps = {
  sprint: PmSprint | undefined;
  sprints: PmSprint[];
  tickets: PmBoardTicket[];
  tier: PmDataTier;
  digest: PmDigestEntry[];
  now: number;
  onOpenTicket(ticketId: string): void;
  onActivate(sprintId: string): void;
  onClose(sprintId: string, carryOverTo: string | undefined): void;
};

export function SprintOverview(props: SprintOverviewProps) {
  const [closing, setClosing] = useState(false);
  const [carryOverTo, setCarryOverTo] = useState("");
  const [standup, setStandup] = useState<string | undefined>(undefined);
  const sprint = props.sprint;
  if (!sprint) {
    return (
      <section className="pm-overview pm-empty">
        <h2>No sprint selected</h2>
        <p className="pm-hint">Create a sprint in the left column, or connect Jira in Settings and pull.</p>
      </section>
    );
  }
  const tickets = props.tickets;
  const atRisk = tickets.filter((entry) => entry.delivery.risks.length > 0);
  const counters = [
    { label: "Tickets", value: tickets.length },
    { label: "Done", value: tickets.filter((entry) => entry.ticket.status === "done").length },
    { label: "In progress", value: tickets.filter((entry) => entry.ticket.status === "inProgress").length },
    { label: "In review", value: tickets.filter((entry) => entry.ticket.status === "inReview").length },
    { label: "At risk", value: atRisk.length, tone: atRisk.length > 0 ? "warn" : "" },
  ];
  const remaining = daysLeft(sprint, props.now);
  const unknown = props.tier === "deploy" ? unknownDeployment(tickets) : [];
  const targets = props.sprints.filter((candidate) => candidate.id !== sprint.id && (candidate.state === "planned" || candidate.state === "backlog"));
  const titleOf = (ticketId: string | null) => tickets.find((entry) => entry.ticket.id === ticketId);

  return (
    <section className="pm-overview" aria-label="Sprint overview">
      <div className="pm-overview-head">
        <div>
          <h2>{sprint.name}</h2>
          <p className="pm-goal">{sprint.goal ?? <span className="pm-muted">No goal set</span>}</p>
        </div>
        <div className="pm-overview-meta">
          <span className={`pm-pill sprint-${sprint.state}`}>{sprint.state}</span>
          {remaining !== undefined && sprint.state === "active" && (
            <span className="pm-days-left">{remaining >= 0 ? `${remaining} days left` : `${-remaining} days over`}</span>
          )}
        </div>
      </div>
      <div className="pm-counters">
        {counters.map((counter) => (
          <div key={counter.label} className={`pm-counter ${counter.tone ?? ""}`}>
            <span className="pm-counter-value">{counter.value}</span>
            <span className="pm-counter-label">{counter.label}</span>
          </div>
        ))}
      </div>
      <div className="pm-overview-actions">
        <button type="button" className="pm-button" onClick={() => setStandup(standupNote(sprint, tickets, props.digest))}>Standup note</button>
        {(sprint.state === "planned" || sprint.state === "backlog") && (
          <button type="button" className="pm-button" onClick={() => props.onActivate(sprint.id)}>Activate sprint</button>
        )}
        {sprint.state === "active" && <button type="button" className="pm-button" onClick={() => setClosing(true)}>Close sprint…</button>}
      </div>
      {closing && (
        <div className="pm-card pm-confirm" role="dialog" aria-label="Close sprint">
          <p>Close <strong>{sprint.name}</strong>? Unfinished tickets move to:</p>
          <select aria-label="Carry over to" value={carryOverTo} onChange={(event) => setCarryOverTo(event.target.value)}>
            <option value="">No sprint (backlog)</option>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
          </select>
          <div className="pm-card-foot">
            <button type="button" className="pm-button ghost" onClick={() => setClosing(false)}>Cancel</button>
            <button type="button" className="pm-button primary" onClick={() => { setClosing(false); props.onClose(sprint.id, carryOverTo || undefined); }}>Close sprint</button>
          </div>
        </div>
      )}
      {standup !== undefined && (
        <div className="pm-card" role="dialog" aria-label="Standup note">
          <div className="pm-card-head"><h3>Standup note</h3><span className="pm-muted">Draft — copy and edit before sharing</span></div>
          <textarea className="pm-description" rows={8} value={standup} onChange={(event) => setStandup(event.target.value)} />
          <div className="pm-card-foot">
            <button type="button" className="pm-button ghost" onClick={() => setStandup(undefined)}>Close</button>
            <button type="button" className="pm-button primary" onClick={() => void navigator.clipboard?.writeText(standup)}>Copy</button>
          </div>
        </div>
      )}
      <section className="pm-card">
        <div className="pm-card-head"><h3>Since yesterday</h3></div>
        {props.digest.length === 0 ? <p className="pm-hint">Nothing changed in the last day.</p> : (
          <ul className="pm-digest">
            {props.digest.map((entry, index) => (
              <li key={index}>
                <span className="pm-muted pm-mono">{relativeTime(entry.atEpochMs, props.now)}</span>
                {entry.ticketId && titleOf(entry.ticketId) ? (
                  <button type="button" className="pm-link" onClick={() => props.onOpenTicket(entry.ticketId!)}>{entry.summary}</button>
                ) : <span>{entry.summary}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="pm-card">
        <div className="pm-card-head"><h3>Needs attention</h3><span className="pm-muted">{atRisk.length}</span></div>
        {atRisk.length === 0 ? <p className="pm-hint">No risks on this sprint.</p> : (
          <table className="pm-table">
            <thead><tr><th>Ticket</th><th>Risk</th><th>Detail</th><th /></tr></thead>
            <tbody>
              {atRisk.flatMap((entry) => entry.delivery.risks.map((risk, index) => (
                <tr key={`${entry.ticket.id}-${index}`}>
                  <td><span className="pm-mono">{ticketLabel(entry.ticket)}</span> {entry.ticket.title}</td>
                  <td>{RISK_LABEL[risk.kind]}</td>
                  <td className="pm-muted">{risk.detail}</td>
                  <td><button type="button" className="pm-link" onClick={() => props.onOpenTicket(entry.ticket.id)}>Open</button></td>
                </tr>
              )))}
            </tbody>
          </table>
        )}
      </section>
      {props.tier === "deploy" && (
        <section className="pm-card" aria-label="Where it runs is unknown">
          <div className="pm-card-head"><h3>Where it runs is unknown</h3><span className="pm-muted">{unknown.length}</span></div>
          {unknown.length === 0 ? <p className="pm-hint">Every merged ticket has a known environment.</p> : (
            <ul className="pm-digest">
              {unknown.map((entry) => (
                <li key={entry.ticket.id}>
                  <span className="pm-mono">{ticketLabel(entry.ticket)}</span>
                  <span>{entry.ticket.title}</span>
                  <span className="pm-pill stage">{STAGE_LABEL[entry.delivery.stage.kind]}</span>
                  <button type="button" className="pm-link" onClick={() => props.onOpenTicket(entry.ticket.id)}>Open</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}

/** A local, editable standup draft from the board and digest. */
export function standupNote(sprint: PmSprint, tickets: PmBoardTicket[], digest: PmDigestEntry[]): string {
  const line = (entry: PmBoardTicket) => `- ${ticketLabel(entry.ticket)} ${entry.ticket.title}`;
  const done = tickets.filter((entry) => entry.ticket.status === "done");
  const active = tickets.filter((entry) => entry.ticket.status === "inProgress" || entry.ticket.status === "inReview");
  const risky = tickets.filter((entry) => entry.delivery.risks.length > 0);
  return [
    `${sprint.name}${sprint.goal ? ` — ${sprint.goal}` : ""}`,
    "",
    `Done (${done.length}):`, ...done.map(line),
    "",
    `In flight (${active.length}):`, ...active.map(line),
    "",
    `Risks (${risky.length}):`, ...risky.map((entry) => `${line(entry)}: ${entry.delivery.risks.map((risk) => RISK_LABEL[risk.kind]).join(", ")}`),
    "",
    `Changes since yesterday: ${digest.length}`,
  ].join("\n");
}
