import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import type { PmBoardTicket, PmDataTier, PmSprint } from "@termloop/pm-contract/pm";
import { Icon } from "./icons.js";
import {
  RISK_LABEL, STAGE_LABEL, STATUS_DOT, STATUS_LABEL, daysLeft, jiraKey, leftSprint, riskTone, sprintDay, sprintTickets, statusSections, tierAtLeast,
} from "./format.js";

/** Which inline form the sprint rail shows. */
export type SprintComposer = "sprint" | "ticket" | undefined;

export type SprintSidebarProps = {
  sprints: PmSprint[];
  tickets: PmBoardTicket[];
  tier: PmDataTier;
  /** The focused sprint; the rail shows it only when no sprint is active. */
  selectedSprintId: string | undefined;
  selectedTicketId: string | undefined;
  now?: number;
  /** Collapsed rails show only their header. */
  collapsed?: boolean;
  onToggle?(): void;
  composer?: SprintComposer;
  onComposer?(composer: SprintComposer): void;
  onSelectSprint(sprintId: string): void;
  onSelectTicket(ticketId: string): void;
  onCreateSprint(name: string, goal: string): void;
  /** Creates a ticket in `sprintId`, the sprint the rail shows. */
  onCreateTicket(title: string, sprintId: string | undefined): void;
  /** Moves a ticket into a lane (`null` is "no sprint"), at `index` within it when given. */
  onMoveTicket(ticketId: string, sprintId: string | null, index?: number): void;
  /** Opens the right Sprints panel. */
  onShowSprints?(): void;
};

/**
 * The left "Sprint" rail: the active sprint (else the focused one) expanded
 * into status sections, then a count of the other sprints. Its tickets are
 * sortable items of the shell's {@link SprintDnd} context.
 */
export function SprintSidebar(props: SprintSidebarProps) {
  const [localComposer, setLocalComposer] = useState<SprintComposer>(undefined);
  const composer = props.onComposer ? props.composer : localComposer;
  const setComposer = props.onComposer ?? setLocalComposer;
  const shown = leftSprint(props.sprints, props.selectedSprintId);
  const lane = shown ? sprintTickets(props.tickets, shown.id) : [];
  const others = props.sprints.length - (shown ? 1 : 0);
  const createTicket = (title: string) => props.onCreateTicket(title, shown?.id);
  return (
    <section className="rail" aria-label="Sprint">
      <div className="rail-header" onClick={props.onToggle}>
        <span className="tg"><Icon name={props.collapsed ? "right" : "down"} /></span>
        <span className="gl"><Icon name="flag" /></span>
        <h2>{shown?.state === "active" || !shown ? "Active Sprint" : "Sprint"}</h2>
        <span className="meta"><span className="count-badge">{lane.length}</span></span>
        <button
          type="button"
          className="icb"
          title="New ticket"
          aria-label="New ticket in this sprint"
          onClick={(event) => { event.stopPropagation(); setComposer(composer === "ticket" ? undefined : "ticket"); }}
        >
          <Icon name="plus" />
        </button>
      </div>
      {!props.collapsed && (
        <>
          {composer === "sprint" && <SprintForm onCreate={(name, goal) => { props.onCreateSprint(name, goal); setComposer(undefined); }} onCancel={() => setComposer(undefined)} />}
          {composer === "ticket" && !shown && <TicketForm onCreate={createTicket} onCancel={() => setComposer(undefined)} />}
          {shown && (
            <FocusedSprint
              sprint={shown}
              tickets={lane}
              all={props.sprints}
              tier={props.tier}
              now={props.now ?? Date.now()}
              selectedTicketId={props.selectedTicketId}
              composing={composer === "ticket"}
              onSelectSprint={() => props.onSelectSprint(shown.id)}
              onSelectTicket={props.onSelectTicket}
              onCreateTicket={createTicket}
              onCloseComposer={() => setComposer(undefined)}
              onMoveTicket={props.onMoveTicket}
            />
          )}
          {others > 0 && (
            <button type="button" className="rail-subhead pm-other-sprints" title="Show all sprints" onClick={props.onShowSprints}>
              Other sprints<span className="n">{others}</span>
            </button>
          )}
          {props.sprints.length === 0 && <p className="rail-empty">No sprints yet. Create one with New sprint, or pull from Jira.</p>}
        </>
      )}
    </section>
  );
}

/** The group head's progress: "day X/N", else days left, else the sprint state. */
function sprintProgress(sprint: PmSprint, now: number): string {
  const day = sprint.state === "active" ? sprintDay(sprint, now) : undefined;
  if (day) return `day ${day.day}/${day.of} · `;
  const remaining = sprint.state === "active" ? daysLeft(sprint, now) : undefined;
  if (remaining !== undefined) return remaining >= 0 ? `${remaining}d left · ` : `${-remaining}d over · `;
  return sprint.state === "active" ? "" : `${sprint.state} · `;
}

export function SprintForm(props: { onCreate(name: string, goal: string): void; onCancel(): void }) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  return (
    <form
      className="rail-form"
      onKeyDown={(event) => { if (event.key === "Escape") props.onCancel(); }}
      onSubmit={(event) => { event.preventDefault(); if (name.trim()) props.onCreate(name, goal); }}
    >
      <input autoFocus placeholder="Sprint name" aria-label="Sprint name" value={name} onChange={(event) => setName(event.target.value)} />
      <input placeholder="Goal (optional)" aria-label="Sprint goal" value={goal} onChange={(event) => setGoal(event.target.value)} />
      <div className="rail-form-actions">
        <button type="button" className="btn sm ghost" onClick={props.onCancel}>Cancel</button>
        <button type="submit" className="btn sm pri" disabled={!name.trim()}>Create sprint</button>
      </div>
    </form>
  );
}

function TicketForm(props: { onCreate(title: string): void; onCancel(): void }) {
  const [title, setTitle] = useState("");
  return (
    <form
      className="rail-form"
      onKeyDown={(event) => { if (event.key === "Escape") props.onCancel(); }}
      onSubmit={(event) => { event.preventDefault(); if (title.trim()) props.onCreate(title); setTitle(""); }}
    >
      <input autoFocus placeholder="New ticket title, Enter to add" aria-label="New ticket title" value={title} onChange={(event) => setTitle(event.target.value)} />
    </form>
  );
}

function FocusedSprint(props: {
  sprint: PmSprint;
  tickets: PmBoardTicket[];
  all: PmSprint[];
  tier: PmDataTier;
  now: number;
  selectedTicketId: string | undefined;
  composing: boolean;
  onSelectSprint(): void;
  onSelectTicket(ticketId: string): void;
  onCreateTicket(title: string): void;
  onCloseComposer(): void;
  onMoveTicket(ticketId: string, sprintId: string | null, index?: number): void;
}) {
  const [folded, setFolded] = useState(false);
  const { sprint, tickets } = props;
  const done = tickets.filter((entry) => entry.ticket.status === "done").length;
  const showStage = tierAtLeast(props.tier, "code");
  const moveTargets = props.all.filter((candidate) => candidate.state !== "closed" && candidate.id !== sprint.id);
  const sections = statusSections(tickets);
  // Move up/down stays within a status section, landing at the neighbour's
  // position in the whole lane.
  const step = (entry: PmBoardTicket, neighbour: PmBoardTicket | undefined) =>
    neighbour ? () => props.onMoveTicket(entry.ticket.id, sprint.id, tickets.indexOf(neighbour)) : undefined;
  return (
    // Not a drop target itself: its tickets are, and a large group would win
    // closest-center collisions over them.
    <div className="group focused">
      <div className="ghead" onClick={props.onSelectSprint}>
        <button
          type="button"
          className="tg"
          aria-label={folded ? `Expand ${sprint.name}` : `Collapse ${sprint.name}`}
          onClick={(event) => { event.stopPropagation(); setFolded(!folded); }}
        >
          <Icon name={folded ? "right" : "down"} />
        </button>
        <strong>{sprint.name}</strong>
        <span className="meta">{sprintProgress(sprint, props.now)}{done}/{tickets.length}</span>
      </div>
      {sprint.goal && <div className="gsub">{sprint.goal}</div>}
      <div className="bar"><i style={{ width: `${tickets.length ? Math.round((done / tickets.length) * 100) : 0}%` }} /></div>
      {!folded && (
        // One sortable context in display order, so a drag can cross status
        // sections; the subheads are plain list items between the rows.
        <SortableContext items={sections.flatMap((section) => section.tickets.map((entry) => entry.ticket.id))} strategy={verticalListSortingStrategy}>
          <ul className="list" aria-label={`${sprint.name} tickets`}>
            {sections.map((section) => [
              <li key={section.status} className="rail-subhead pm-status-head">
                {STATUS_LABEL[section.status]}<span className="n">{section.tickets.length}</span>
              </li>,
              ...section.tickets.map((entry, index) => (
                <TicketRow
                  key={entry.ticket.id}
                  entry={entry}
                  showStage={showStage}
                  selected={entry.ticket.id === props.selectedTicketId}
                  onSelect={() => props.onSelectTicket(entry.ticket.id)}
                  moves={{
                    up: step(entry, section.tickets[index - 1]),
                    down: step(entry, section.tickets[index + 1]),
                    to: moveTargets.map((target) => ({ label: target.name, move: () => props.onMoveTicket(entry.ticket.id, target.id) })),
                    toNoSprint: () => props.onMoveTicket(entry.ticket.id, null),
                  }}
                />
              )),
            ])}
            {tickets.length === 0 && <li className="rail-empty">No tickets in this sprint.</li>}
          </ul>
        </SortableContext>
      )}
      {props.composing && sprint.state !== "closed" && <TicketForm onCreate={props.onCreateTicket} onCancel={props.onCloseComposer} />}
    </div>
  );
}

type TicketMoves = {
  up: (() => void) | undefined;
  down: (() => void) | undefined;
  to: { label: string; move(): void }[];
  toNoSprint(): void;
};

/** The keyboard-reachable alternative to dragging. */
function MoveMenu(props: { moves: TicketMoves; title: string }) {
  const [open, setOpen] = useState(false);
  const pick = (move: () => void) => () => { setOpen(false); move(); };
  return (
    <div className="pm-move-menu" onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
      <button type="button" className="icb" aria-label={`Move ${props.title}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <div role="menu" className="pm-menu">
          <button type="button" role="menuitem" disabled={!props.moves.up} onClick={props.moves.up && pick(props.moves.up)}>Move up</button>
          <button type="button" role="menuitem" disabled={!props.moves.down} onClick={props.moves.down && pick(props.moves.down)}>Move down</button>
          {props.moves.to.map((target) => (
            <button key={target.label} type="button" role="menuitem" onClick={pick(target.move)}>Move to {target.label}</button>
          ))}
          <button type="button" role="menuitem" onClick={pick(props.moves.toNoSprint)}>Remove from sprint</button>
        </div>
      )}
    </div>
  );
}

function TicketRow(props: { entry: PmBoardTicket; showStage: boolean; selected: boolean; onSelect(): void; moves: TicketMoves }) {
  const { ticket, delivery, pendingProposalCount } = props.entry;
  const key = jiraKey(ticket);
  const sortable = useSortable({ id: ticket.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const risks = delivery.risks.filter((risk) => risk.kind !== "unassigned" && risk.kind !== "carriedOver");
  return (
    <li ref={sortable.setNodeRef} style={style} className={`pm-ticket-item ${sortable.isDragging ? "dragging" : ""}`}>
      <button
        type="button"
        className={`row ${props.selected ? "active" : ""}`}
        aria-current={props.selected ? "true" : undefined}
        onClick={props.onSelect}
        {...sortable.listeners}
      >
        <span className={`dot ${STATUS_DOT[ticket.status]}`} aria-hidden="true" />
        <span className="copy">
          <span className="row-title">{key && <span className="key">{key}</span>}{ticket.title}</span>
          <span className="row-sub">
            {ticket.assignee ? <span className="who">{ticket.assignee}</span> : <span className="warn">unassigned</span>}
            <span>{STATUS_LABEL[ticket.status].toLowerCase()}</span>
            {props.showStage && (
              <span className="stage" data-testid="stage-pill">
                {STAGE_LABEL[delivery.stage.kind].toLowerCase()}{delivery.stage.environment ? ` · ${delivery.stage.environment}` : ""}
              </span>
            )}
            {ticket.carryOverCount > 0 && <span className="warn" title="Carried over">carried over ×{ticket.carryOverCount}</span>}
            {risks.map((risk, index) => (
              <span key={index} className={riskTone(risk.kind)} title={risk.detail}>{RISK_LABEL[risk.kind].toLowerCase()}</span>
            ))}
            {pendingProposalCount > 0 && <span className="draft">draft</span>}
            {delivery.checking && <span className="warn">checking…</span>}
          </span>
        </span>
        <span />
      </button>
      <MoveMenu moves={props.moves} title={ticket.title} />
    </li>
  );
}
