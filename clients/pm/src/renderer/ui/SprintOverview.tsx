import { useState } from "react";
import type { PmBoardTicket, PmDataTier, PmDigestEntry, PmPlaybook, PmSprint } from "@termloop/pm-contract/pm";
import { RISK_LABEL, attentionRows, dayRuler, sprintDay, stepRibbon, ticketLabel, waitingAtStep } from "./format.js";

export type SprintOverviewProps = {
  sprint: PmSprint | undefined;
  sprints: PmSprint[];
  tickets: PmBoardTicket[];
  tier: PmDataTier;
  /** The project's Playbook: the ribbon counts tickets per step. */
  playbook: PmPlaybook | undefined;
  digest: PmDigestEntry[];
  now: number;
  onOpenTicket(ticketId: string): void;
  onActivate(sprintId: string): void;
  onClose(sprintId: string, carryOverTo: string | undefined): void;
  onDelete(sprintId: string): void;
};

const ENDS = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

export function SprintOverview(props: SprintOverviewProps) {
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [carryOverTo, setCarryOverTo] = useState("");
  const [standup, setStandup] = useState<string | undefined>(undefined);
  const sprint = props.sprint;
  if (!sprint) {
    return (
      <section className="pane" aria-label="Sprint overview">
        <div className="pane-head"><b>No sprint selected</b></div>
        <div className="body empty-state">
          <p className="lead">Create a sprint with New sprint in the sidebar, or connect Jira in Settings and pull.</p>
        </div>
      </section>
    );
  }
  const tickets = props.tickets;
  const attention = attentionRows(tickets);
  const ruler = dayRuler(sprint, props.now);
  const position = sprintDay(sprint, props.now);
  const ribbon = props.playbook ? stepRibbon(tickets, props.playbook) : [];
  const waiting = props.tier === "deploy" && props.playbook ? waitingAtStep(tickets, props.playbook) : [];
  const targets = props.sprints.filter((candidate) => candidate.id !== sprint.id && (candidate.state === "planned" || candidate.state === "backlog"));
  const known = (ticketId: string | null) => ticketId !== null && tickets.some((entry) => entry.ticket.id === ticketId);
  const meta = [
    sprint.state !== "active" ? sprint.state : undefined,
    position && sprint.state === "active" ? `day ${position.day} of ${position.of}` : undefined,
    sprint.endsAtEpochMs !== null ? `ends ${ENDS.format(sprint.endsAtEpochMs)}` : undefined,
  ].filter(Boolean).join(" · ");

  return (
    <section className="pane overview-pane" aria-label="Sprint overview">
      <div className="pane-head">
        <b>{sprint.name}</b>
        <span className="meta">{meta}</span>
        <span className="sp" />
        <button type="button" className="btn sm" onClick={() => setStandup(standupNote(sprint, tickets, props.digest))}>Standup note</button>
        {(sprint.state === "planned" || sprint.state === "backlog") && (
          <button type="button" className="btn sm" onClick={() => props.onActivate(sprint.id)}>Activate sprint</button>
        )}
        {sprint.state === "active" && <button type="button" className="btn sm" onClick={() => setClosing(true)}>Close sprint</button>}
        <button type="button" className="btn sm ghost" onClick={() => setDeleting(true)}>Delete sprint</button>
      </div>
      <div className="body">
        <p className="lead">{sprint.goal ?? <span className="muted">No goal set.</span>}</p>
        {closing && (
          <div className="card" role="dialog" aria-label="Close sprint">
            <p>Close <strong>{sprint.name}</strong>? Unfinished tickets move to:</p>
            <select aria-label="Carry over to" value={carryOverTo} onChange={(event) => setCarryOverTo(event.target.value)}>
              <option value="">No sprint (backlog)</option>
              {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
            </select>
            <div className="card-foot">
              <button type="button" className="btn sm ghost" onClick={() => setClosing(false)}>Cancel</button>
              <button type="button" className="btn sm pri" onClick={() => { setClosing(false); props.onClose(sprint.id, carryOverTo || undefined); }}>Close sprint</button>
            </div>
          </div>
        )}
        {deleting && (
          <div className="card" role="dialog" aria-label="Delete sprint">
            <p>
              Delete <strong>{sprint.name}</strong>? Its {tickets.length} {tickets.length === 1 ? "ticket moves" : "tickets move"} to No sprint. This cannot be undone.
            </p>
            <div className="card-foot">
              <button type="button" className="btn sm ghost" onClick={() => setDeleting(false)}>Cancel</button>
              <button type="button" className="btn sm pri" onClick={() => { setDeleting(false); props.onDelete(sprint.id); }}>Delete sprint</button>
            </div>
          </div>
        )}
        {standup !== undefined && (
          <div className="card" role="dialog" aria-label="Standup note">
            <div className="card-head"><span className="sec-label">Standup note</span><span className="meta">Draft. Copy and edit before sharing.</span></div>
            <textarea className="description" rows={8} value={standup} onChange={(event) => setStandup(event.target.value)} />
            <div className="card-foot">
              <button type="button" className="btn sm ghost" onClick={() => setStandup(undefined)}>Close</button>
              <button type="button" className="btn sm pri" onClick={() => void navigator.clipboard?.writeText(standup)}>Copy</button>
            </div>
          </div>
        )}
        {ruler.length > 0 && (
          <div className="ruler" style={{ gridTemplateColumns: `repeat(${ruler.length}, minmax(0, 1fr))` }} aria-label="Sprint days">
            {ruler.map((day) => (
              <div key={day.epochMs} className={`ruler-day ${day.kind} ${day.weekend ? "weekend" : ""}`} title={DAY.format(day.epochMs)}>{day.label}</div>
            ))}
          </div>
        )}
        <div className="ribbon" aria-hidden="true">
          {ribbon.filter((segment) => segment.count > 0).map((segment) => <i key={segment.key} className={segment.className} style={{ flex: segment.count }} />)}
          {tickets.length === 0 && <i className="empty" style={{ flex: 1 }} />}
        </div>
        <div className="legend">
          {ribbon.map((segment) => <span key={segment.key}><b>{segment.count}</b> {segment.label}</span>)}
        </div>

        <h3 className="s">Needs your attention <small>{attention.length} {attention.length === 1 ? "ticket" : "tickets"}</small></h3>
        {attention.length === 0 ? <p className="hint">No risks on this sprint.</p> : (
          <div className="ruled" aria-label="Needs attention">
            {attention.map((row) => {
              const entry = tickets.find((candidate) => candidate.ticket.id === row.ticketId)!;
              return (
                <div key={row.ticketId} className="ruled-row attn-row">
                  <span className="k">{row.label}</span>
                  <span>
                    <div className="ruled-title">{entry.ticket.title}</div>
                    <div className="ruled-detail">
                      <span className={row.tone}>{row.title}.</span> {row.detail}
                    </div>
                  </span>
                  <button type="button" className="link" onClick={() => props.onOpenTicket(row.ticketId)}>Open</button>
                </div>
              );
            })}
          </div>
        )}

        <h3 className="s">Since yesterday <small>from Jira, pull requests and this app</small></h3>
        {props.digest.length === 0 ? <p className="hint">Nothing changed in the last day.</p> : (
          <div className="digest">
            {props.digest.map((entry, index) => (
              <div key={index} className="digest-row">
                <time dateTime={new Date(entry.atEpochMs).toISOString()}>{CLOCK.format(entry.atEpochMs)}</time>
                {known(entry.ticketId) ? (
                  <button type="button" className="link plain" onClick={() => props.onOpenTicket(entry.ticketId!)}>{entry.summary}</button>
                ) : <span>{entry.summary}</span>}
              </div>
            ))}
          </div>
        )}

        {props.tier === "deploy" && (
          <section aria-label="Waiting at a step">
            <h3 className="s">Waiting at a step <small>{waiting.length} {waiting.length === 1 ? "ticket" : "tickets"}</small></h3>
            {waiting.length === 0 ? <p className="hint">No ticket is waiting at a step an agent checks.</p> : (
              <div className="ruled">
                {waiting.map(({ entry, step, state }) => (
                  <div key={entry.ticket.id} className="ruled-row">
                    <span className="k">{ticketLabel(entry.ticket)}</span>
                    <span>
                      <div className="ruled-title">{entry.ticket.title}</div>
                      <div className="ruled-detail">
                        <span className={state.verdict === "blocked" ? "bad" : "warn"}>{step.title}: {state.verdict}.</span> {state.evidence}
                      </div>
                    </span>
                    {entry.delivery.checking
                      ? <span className="chip">checking</span>
                      : <button type="button" className="btn sm" onClick={() => props.onOpenTicket(entry.ticket.id)}>Open</button>}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </section>
  );
}

const UNASSIGNED = "Unassigned";

/**
 * A local, editable standup draft from the board and digest, grouped per
 * assignee into done, in progress (in progress or in review), and blocked
 * (a blocker or a delivery risk). Nothing is sent anywhere.
 */
export function standupNote(sprint: PmSprint, tickets: PmBoardTicket[], digest: PmDigestEntry[]): string {
  const line = (entry: PmBoardTicket) => `  - ${ticketLabel(entry.ticket)} ${entry.ticket.title}`;
  const blockedLine = (entry: PmBoardTicket) => {
    const reasons = [
      ...entry.ticket.blockers.map((blocker) => blocker.text),
      // A blocker already names why; its "Blocked" risk would repeat it.
      ...entry.delivery.risks
        .filter((risk) => !(risk.kind === "blocked" && entry.ticket.blockers.length > 0))
        .map((risk) => RISK_LABEL[risk.kind]),
    ];
    return `${line(entry)}: ${reasons.join(", ")}`;
  };
  const people = new Map<string, PmBoardTicket[]>();
  for (const entry of tickets) {
    const name = entry.ticket.assignee ?? UNASSIGNED;
    people.set(name, [...(people.get(name) ?? []), entry]);
  }
  const names = [...people.keys()].sort((left, right) =>
    left === UNASSIGNED ? 1 : right === UNASSIGNED ? -1 : left.localeCompare(right));
  const lines = [`${sprint.name}${sprint.goal ? ` — ${sprint.goal}` : ""}`];
  for (const name of names) {
    const own = people.get(name)!;
    const blocked = own.filter((entry) => entry.ticket.status !== "done" && (entry.ticket.blockers.length > 0 || entry.delivery.risks.length > 0));
    const done = own.filter((entry) => entry.ticket.status === "done");
    const active = own.filter((entry) => (entry.ticket.status === "inProgress" || entry.ticket.status === "inReview") && !blocked.includes(entry));
    if (done.length + active.length + blocked.length === 0) continue;
    lines.push("", `${name}:`);
    if (done.length) lines.push(` Done (${done.length}):`, ...done.map(line));
    if (active.length) lines.push(` In progress (${active.length}):`, ...active.map(line));
    if (blocked.length) lines.push(` Blocked (${blocked.length}):`, ...blocked.map(blockedLine));
  }
  lines.push("", `Changes since yesterday: ${digest.length}`);
  return lines.join("\n");
}
