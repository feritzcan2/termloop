import { useState } from "react";
import type { PmBoardTicket, PmDataTier, PmDigestEntry, PmPlaybook, PmSprint } from "@termloop/pm-contract/pm";
import { Icon } from "./icons.js";
import { PRIORITY_LABEL, RISK_LABEL, dayRuler, nextStep, riskTone, sprintDay, sprintPanelOrder, statusColumns, stepColumns, tierAtLeast, ticketLabel } from "./format.js";

export type SprintOverviewProps = {
  sprint: PmSprint | undefined;
  sprints: PmSprint[];
  tickets: PmBoardTicket[];
  tier: PmDataTier;
  /** The project's Playbook: the board has one column per step, else one per status. */
  playbook: PmPlaybook | undefined;
  digest: PmDigestEntry[];
  /** The Jira board the project's sprints come from, if any. */
  jiraBoardId: number | null;
  now: number;
  onOpenTicket(ticketId: string): void;
  onActivate(sprintId: string): void;
  onClose(sprintId: string, carryOverTo: string | undefined): void;
  onDelete(sprintId: string): void;
  /** Switches the board to another sprint. */
  onSelectSprint?(sprintId: string): void;
};

const ENDS = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const DAY = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

export function SprintOverview(props: SprintOverviewProps) {
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [carryOverTo, setCarryOverTo] = useState("");
  const [standup, setStandup] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [assignee, setAssignee] = useState<string | undefined>(undefined);
  const sprint = props.sprint;
  if (!sprint) {
    return (
      <section className="pane" aria-label="Sprint overview">
        <div className="pane-head"><b>No sprint selected</b></div>
        <div className="body empty-state">
          <p className="lead">Create a sprint on the Sprints page, or connect Jira in Settings and pull.</p>
        </div>
      </section>
    );
  }
  const tickets = props.tickets;
  const ruler = dayRuler(sprint, props.now);
  const position = sprintDay(sprint, props.now);
  const people = assignees(tickets);
  const shown = boardFilter(tickets, query, assignee);
  const columns = props.playbook?.steps.length ? stepColumns(shown, props.playbook) : statusColumns(shown);
  const targets = props.sprints.filter((candidate) => candidate.id !== sprint.id && (candidate.state === "planned" || candidate.state === "backlog"));
  // Jira owns an open sprint of the project's board: a pull would bring it back.
  const jiraOwned = sprint.jiraSprintId !== null && sprint.state !== "closed" && sprint.jiraBoardId === props.jiraBoardId;
  const meta = [
    sprint.state !== "active" ? sprint.state : undefined,
    position && sprint.state === "active" ? `day ${position.day} of ${position.of}` : undefined,
    sprint.endsAtEpochMs !== null ? `ends ${ENDS.format(sprint.endsAtEpochMs)}` : undefined,
  ].filter(Boolean).join(" · ");

  return (
    <section className="pane overview-pane" aria-label="Sprint overview">
      <div className="pane-head">
        {props.onSelectSprint && props.sprints.length > 1 ? (
          <select className="sprint-pick" aria-label="Sprint" value={sprint.id} onChange={(event) => props.onSelectSprint?.(event.target.value)}>
            {sprintPanelOrder(props.sprints).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.state === "active" ? " · active" : candidate.state === "closed" ? " · closed" : ""}</option>
            ))}
          </select>
        ) : <b>{sprint.name}</b>}
        <span className="meta">{meta}</span>
        {sprint.jiraSprintId !== null && (
          <span className="chip" title={jiraOwned ? "Synced from Jira: Jira owns its name, dates, and state" : "Imported from Jira"}>
            <Icon name="jira" />Jira
          </span>
        )}
        <span className="sp" />
        <button type="button" className="btn sm" onClick={() => setStandup(standupNote(sprint, tickets, props.digest))}>Standup note</button>
        {(sprint.state === "planned" || sprint.state === "backlog") && (
          <button type="button" className="btn sm" onClick={() => props.onActivate(sprint.id)}>Activate sprint</button>
        )}
        {sprint.state === "active" && <button type="button" className="btn sm" onClick={() => setClosing(true)}>Close sprint</button>}
        {!jiraOwned && <button type="button" className="btn sm ghost" onClick={() => setDeleting(true)}>Delete sprint</button>}
      </div>
      <div className="board-top">
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
              <div key={day.epochMs} className={`ruler-day ${day.kind} ${day.weekend ? "weekend" : ""}`} title={DAY.format(day.epochMs)}><span>{day.label}</span></div>
            ))}
          </div>
        )}
        <div className="board-filters">
          <label className="board-search">
            <Icon name="search" />
            <input type="search" placeholder="Search board" aria-label="Search board" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="board-people" role="group" aria-label="Filter by assignee">
            {people.map((name) => (
              <button
                key={name}
                type="button"
                className={`avatar ${assignee === name ? "on" : ""}`}
                title={name}
                aria-pressed={assignee === name}
                onClick={() => setAssignee(assignee === name ? undefined : name)}
              >
                {initials(name)}
              </button>
            ))}
          </div>
          {(query || assignee !== undefined) && (
            <button type="button" className="btn sm ghost" onClick={() => { setQuery(""); setAssignee(undefined); }}>Clear filters</button>
          )}
        </div>
      </div>
      <div className="board" aria-label="Sprint board">
        {columns.map((column) => (
          <section key={column.key} className="board-col" aria-label={column.title}>
            <header className="board-col-head"><span className="board-col-title">{column.title}</span><small>{column.tickets.length}</small></header>
            <ul className="board-cards">
              {column.tickets.map((entry) => (
                <li key={entry.ticket.id}>
                  <BoardCard entry={entry} tier={props.tier} playbook={props.playbook} onOpen={() => props.onOpenTicket(entry.ticket.id)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

function BoardCard(props: { entry: PmBoardTicket; tier: PmDataTier; playbook: PmPlaybook | undefined; onOpen(): void }) {
  const { ticket, delivery, pendingProposalCount } = props.entry;
  const pullRequests = tierAtLeast(props.tier, "code") ? delivery.facts?.pullRequests ?? 0 : 0;
  // What an agent found at the step the ticket works toward.
  const next = props.playbook ? nextStep(props.playbook, delivery) : undefined;
  const held = next?.state && (next.state.verdict === "waiting" || next.state.verdict === "blocked") ? { step: next.step, state: next.state } : undefined;
  const risks = delivery.risks.filter((risk) => risk.kind !== "unassigned");
  const blocked = held?.state.verdict === "blocked" || risks.some((risk) => riskTone(risk.kind) === "bad");
  return (
    <button type="button" className={`board-card ${blocked ? "blocked" : ""}`} onClick={props.onOpen}>
      <span className="board-card-title">{ticket.title}</span>
      {(risks.length > 0 || held || pendingProposalCount > 0 || delivery.checking) && (
        <span className="board-card-tags">
          {held && (
            <span className={`step-pill ${held.state.verdict === "blocked" ? "bad" : ""}`} title={held.state.evidence ?? undefined}>
              {held.state.verdict} · {held.step.title.toLowerCase()}
            </span>
          )}
          {risks.map((risk, index) => (
            <span key={index} className={`risk ${riskTone(risk.kind)}`} title={risk.detail}>{RISK_LABEL[risk.kind].toLowerCase()}</span>
          ))}
          {pendingProposalCount > 0 && (
            <span className="draft-pill" title="Assistant drafts waiting for your review">
              {pendingProposalCount === 1 ? "draft" : `${pendingProposalCount} drafts`}
            </span>
          )}
          {delivery.checking && <span className="risk warn">checking…</span>}
        </span>
      )}
      <span className="board-card-foot">
        <span className="k">{ticketLabel(ticket)}</span>
        <span className={`prio ${ticket.priority}`} title={`${PRIORITY_LABEL[ticket.priority]} priority`} aria-label={`${PRIORITY_LABEL[ticket.priority]} priority`} />
        {pullRequests > 0 && <span className="pr-chip" title="Linked pull requests">PR·{pullRequests}</span>}
        <span className="sp" />
        {ticket.assignee
          ? <span className="avatar" title={ticket.assignee}>{initials(ticket.assignee)}</span>
          : <span className="avatar none" title="Unassigned">?</span>}
      </span>
    </button>
  );
}

/** The sprint's assignees, by name. */
function assignees(tickets: PmBoardTicket[]): string[] {
  return [...new Set(tickets.flatMap((entry) => (entry.ticket.assignee ? [entry.ticket.assignee] : [])))].sort((left, right) => left.localeCompare(right));
}

/** Tickets whose key or title holds the query, assigned to `assignee` when one is chosen. */
export function boardFilter(tickets: PmBoardTicket[], query: string, assignee: string | undefined): PmBoardTicket[] {
  const needle = query.trim().toLowerCase();
  return tickets.filter((entry) =>
    (assignee === undefined || entry.ticket.assignee === assignee)
    && (!needle || entry.ticket.title.toLowerCase().includes(needle) || ticketLabel(entry.ticket).toLowerCase().includes(needle)));
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
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
