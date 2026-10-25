import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import type { PmBoardTicket, PmDataTier, PmSprint } from "@termloop/pm-contract/pm";
import { Icon } from "./icons.js";
import { RISK_LABEL, STAGE_LABEL, STATUS_DOT, STATUS_LABEL, daysLeft, jiraKey, riskTone, sprintTickets, tierAtLeast } from "./format.js";

/** Which inline form the sprint rail shows. */
export type SprintComposer = "sprint" | "ticket" | undefined;

export type SprintSidebarProps = {
  sprints: PmSprint[];
  tickets: PmBoardTicket[];
  tier: PmDataTier;
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
  onCreateTicket(title: string): void;
  /** Moves a ticket into a lane (`null` is "no sprint"), at `index` within it when given. */
  onMoveTicket(ticketId: string, sprintId: string | null, index?: number): void;
};

/** Drop target id of a sprint row; "no sprint" uses {@link NO_SPRINT}. */
const LANE_PREFIX = "lane:";
const NO_SPRINT = `${LANE_PREFIX}none`;

/**
 * Where a drag ends: onto a sprint row (move to its end), or onto another
 * ticket of the shown lane (reorder to that position). `undefined` is a no-op.
 */
export function dropTarget(
  activeId: string,
  overId: string | undefined,
  lane: PmBoardTicket[],
  laneSprintId: string,
): { sprintId: string | null; index?: number } | undefined {
  if (!overId || overId === activeId) return undefined;
  if (overId.startsWith(LANE_PREFIX)) {
    const sprintId = overId === NO_SPRINT ? null : overId.slice(LANE_PREFIX.length);
    return sprintId === laneSprintId ? undefined : { sprintId };
  }
  const index = lane.findIndex((entry) => entry.ticket.id === overId);
  if (index < 0 || !lane.some((entry) => entry.ticket.id === activeId)) return undefined;
  return { sprintId: laneSprintId, index };
}

const OPEN_ORDER: Record<PmSprint["state"], number> = { active: 0, planned: 1, backlog: 2, closed: 3 };
const CLOSED_DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

function doneOf(tickets: PmBoardTicket[]): string {
  return `${tickets.filter((entry) => entry.ticket.status === "done").length}/${tickets.length}`;
}

/** The "Sprints" rail: the selected sprint as a focused group, then the others. */
export function SprintSidebar(props: SprintSidebarProps) {
  const [localComposer, setLocalComposer] = useState<SprintComposer>(undefined);
  const composer = props.onComposer ? props.composer : localComposer;
  const setComposer = props.onComposer ?? setLocalComposer;
  const selected = props.sprints.find((sprint) => sprint.id === props.selectedSprintId);
  const tickets = selected ? sprintTickets(props.tickets, selected.id) : [];
  const unsprinted = sprintTickets(props.tickets, undefined).length;
  // Pointer only: a short move starts a drag, so a click still selects. The
  // keyboard path is each row's move menu.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const dragEnd = (event: DragEndEvent) => {
    if (!selected) return;
    const target = dropTarget(String(event.active.id), event.over ? String(event.over.id) : undefined, tickets, selected.id);
    if (target) props.onMoveTicket(String(event.active.id), target.sprintId, target.index);
  };
  const others = props.sprints
    .filter((sprint) => sprint.id !== selected?.id)
    .sort((left, right) => OPEN_ORDER[left.state] - OPEN_ORDER[right.state]);
  const open = others.filter((sprint) => sprint.state !== "closed");
  const closed = others.filter((sprint) => sprint.state === "closed");
  const rowOf = (sprint: PmSprint) => (
    <SprintRow
      key={sprint.id}
      sprint={sprint}
      sub={sprintSub(sprint, sprintTickets(props.tickets, sprint.id))}
      onSelect={() => props.onSelectSprint(sprint.id)}
    />
  );
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
      <section className="rail" aria-label="Sprints">
        <div className="rail-header" onClick={props.onToggle}>
          <span className="tg"><Icon name={props.collapsed ? "right" : "down"} /></span>
          <span className="gl"><Icon name="flag" /></span>
          <h2>Sprints</h2>
          <span className="meta"><span className="count-badge">{props.sprints.length}</span></span>
          <button
            type="button"
            className="icb"
            title="New sprint"
            aria-label="New sprint"
            onClick={(event) => { event.stopPropagation(); setComposer(composer === "sprint" ? undefined : "sprint"); }}
          >
            <Icon name="plus" />
          </button>
        </div>
        {!props.collapsed && (
          <>
            {composer === "sprint" && <SprintForm onCreate={(name, goal) => { props.onCreateSprint(name, goal); setComposer(undefined); }} onCancel={() => setComposer(undefined)} />}
            {composer === "ticket" && !selected && <TicketForm onCreate={props.onCreateTicket} onCancel={() => setComposer(undefined)} />}
            {selected && (
              <FocusedSprint
                sprint={selected}
                tickets={tickets}
                all={props.sprints}
                tier={props.tier}
                now={props.now ?? Date.now()}
                selectedTicketId={props.selectedTicketId}
                composing={composer === "ticket"}
                onSelectSprint={() => props.onSelectSprint(selected.id)}
                onSelectTicket={props.onSelectTicket}
                onCreateTicket={props.onCreateTicket}
                onCloseComposer={() => setComposer(undefined)}
                onMoveTicket={props.onMoveTicket}
              />
            )}
            {(open.length > 0 || props.sprints.length > 0) && (
              <div className="list sprint-rows">
                {open.map(rowOf)}
                {props.sprints.length > 0 && <NoSprintTarget count={unsprinted} />}
              </div>
            )}
            {closed.length > 0 && (
              <>
                <div className="rail-subhead">Closed</div>
                <div className="list">{closed.map(rowOf)}</div>
              </>
            )}
            {props.sprints.length === 0 && <p className="rail-empty">No sprints yet. Create one with +, or pull from Jira.</p>}
          </>
        )}
      </section>
    </DndContext>
  );
}

function sprintSub(sprint: PmSprint, tickets: PmBoardTicket[]): string {
  if (sprint.state === "closed") {
    return `${doneOf(tickets)}${sprint.closedAtEpochMs !== null ? ` · closed ${CLOSED_DATE.format(sprint.closedAtEpochMs)}` : ""}`;
  }
  return `${sprint.state} · ${doneOf(tickets)}`;
}

function SprintForm(props: { onCreate(name: string, goal: string): void; onCancel(): void }) {
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
  const remaining = sprint.state === "active" ? daysLeft(sprint, props.now) : undefined;
  const left = remaining === undefined ? sprint.state === "active" ? "" : `${sprint.state} · ` : remaining >= 0 ? `${remaining}d left · ` : `${-remaining}d over · `;
  const showStage = tierAtLeast(props.tier, "code");
  const moveTargets = props.all.filter((candidate) => candidate.state !== "closed" && candidate.id !== sprint.id);
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
        <span className="meta">{left}{done}/{tickets.length}</span>
      </div>
      {sprint.goal && <div className="gsub">{sprint.goal}</div>}
      <div className="bar"><i style={{ width: `${tickets.length ? Math.round((done / tickets.length) * 100) : 0}%` }} /></div>
      {!folded && (
        <SortableContext items={tickets.map((entry) => entry.ticket.id)} strategy={verticalListSortingStrategy}>
          <ul className="list" aria-label={`${sprint.name} tickets`}>
            {tickets.map((entry, index) => (
              <TicketRow
                key={entry.ticket.id}
                entry={entry}
                showStage={showStage}
                selected={entry.ticket.id === props.selectedTicketId}
                onSelect={() => props.onSelectTicket(entry.ticket.id)}
                moves={{
                  up: index > 0 ? () => props.onMoveTicket(entry.ticket.id, sprint.id, index - 1) : undefined,
                  down: index < tickets.length - 1 ? () => props.onMoveTicket(entry.ticket.id, sprint.id, index + 1) : undefined,
                  to: moveTargets.map((target) => ({ label: target.name, move: () => props.onMoveTicket(entry.ticket.id, target.id) })),
                  toNoSprint: () => props.onMoveTicket(entry.ticket.id, null),
                }}
              />
            ))}
            {tickets.length === 0 && <li className="rail-empty">No tickets in this sprint.</li>}
          </ul>
        </SortableContext>
      )}
      {props.composing && sprint.state !== "closed" && <TicketForm onCreate={props.onCreateTicket} onCancel={props.onCloseComposer} />}
    </div>
  );
}

function SprintRow(props: { sprint: PmSprint; sub: string; onSelect(): void }) {
  const droppable = useDroppable({ id: `${LANE_PREFIX}${props.sprint.id}`, disabled: props.sprint.state === "closed" });
  return (
    <button
      ref={droppable.setNodeRef}
      type="button"
      className={`row sprint-row ${props.sprint.state} ${droppable.isOver ? "drop-over" : ""}`}
      onClick={props.onSelect}
    >
      <span className="sq" />
      <span className="copy">
        <span className="row-title">{props.sprint.name}</span>
        <span className="row-sub">{props.sub}</span>
      </span>
      <span />
    </button>
  );
}

/** Drop target for taking a ticket out of every sprint. */
function NoSprintTarget(props: { count: number }) {
  const droppable = useDroppable({ id: NO_SPRINT });
  return (
    <div ref={droppable.setNodeRef} className={`row pm-no-sprint ${droppable.isOver ? "drop-over" : ""}`} title="Drop a ticket here to take it out of its sprint">
      <span className="sq" />
      <span className="copy">
        <span className="row-title">No sprint</span>
        <span className="row-sub">{props.count} {props.count === 1 ? "ticket" : "tickets"}</span>
      </span>
      <span />
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
