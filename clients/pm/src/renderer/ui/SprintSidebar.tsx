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
import type { PmBoardTicket, PmDataTier, PmSprint, PmSprintState } from "@termloop/pm-contract/pm";
import { STAGE_LABEL, STATUS_LABEL, sprintTickets, ticketLabel, tierAtLeast } from "./format.js";

export type SprintSidebarProps = {
  sprints: PmSprint[];
  tickets: PmBoardTicket[];
  tier: PmDataTier;
  selectedSprintId: string | undefined;
  selectedTicketId: string | undefined;
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

const SPRINT_GROUPS: { state: PmSprintState; label: string }[] = [
  { state: "active", label: "Active" },
  { state: "planned", label: "Planned" },
  { state: "backlog", label: "Backlog" },
  { state: "closed", label: "Closed" },
];

export function SprintSidebar(props: SprintSidebarProps) {
  const [creatingSprint, setCreatingSprint] = useState(false);
  const [sprintName, setSprintName] = useState("");
  const [sprintGoal, setSprintGoal] = useState("");
  const [ticketTitle, setTicketTitle] = useState("");
  const selected = props.sprints.find((sprint) => sprint.id === props.selectedSprintId);
  const tickets = selected ? sprintTickets(props.tickets, selected.id) : [];
  const showStage = tierAtLeast(props.tier, "code");
  const unsprinted = sprintTickets(props.tickets, undefined).length;
  // Pointer only: a short move starts a drag, so a click still selects. The
  // keyboard path is each row's move menu.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const dragEnd = (event: DragEndEvent) => {
    if (!selected) return;
    const target = dropTarget(String(event.active.id), event.over ? String(event.over.id) : undefined, tickets, selected.id);
    if (target) props.onMoveTicket(String(event.active.id), target.sprintId, target.index);
  };
  const moveTargets = props.sprints.filter((sprint) => sprint.state !== "closed" && sprint.id !== selected?.id);
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
    <aside className="pm-sidebar" aria-label="Sprints">
      <div className="pm-section-head">
        <span>Sprints</span>
        <button type="button" className="pm-icon-button" title="New sprint" onClick={() => setCreatingSprint(!creatingSprint)}>+</button>
      </div>
      {creatingSprint && (
        <form
          className="pm-stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onCreateSprint(sprintName, sprintGoal);
            setSprintName("");
            setSprintGoal("");
            setCreatingSprint(false);
          }}
        >
          <input autoFocus placeholder="Sprint name" aria-label="Sprint name" value={sprintName} onChange={(event) => setSprintName(event.target.value)} />
          <input placeholder="Goal (optional)" aria-label="Sprint goal" value={sprintGoal} onChange={(event) => setSprintGoal(event.target.value)} />
          <button type="submit" className="pm-button primary" disabled={!sprintName.trim()}>Create sprint</button>
        </form>
      )}
      <div className="pm-sprint-list">
        {SPRINT_GROUPS.map((group) => {
          const sprints = props.sprints.filter((sprint) => sprint.state === group.state);
          if (sprints.length === 0) return null;
          return (
            <div key={group.state} className="pm-sprint-group">
              <div className="pm-group-label">{group.label}</div>
              {sprints.map((sprint) => (
                <SprintRow
                  key={sprint.id}
                  sprint={sprint}
                  count={sprintTickets(props.tickets, sprint.id).length}
                  selected={sprint.id === props.selectedSprintId}
                  onSelect={() => props.onSelectSprint(sprint.id)}
                />
              ))}
            </div>
          );
        })}
        {props.sprints.length === 0 && <p className="pm-hint">No sprints yet. Create one with +, or pull from Jira.</p>}
        {props.sprints.length > 0 && <NoSprintTarget count={unsprinted} />}
      </div>
      {selected && (
        <>
          <div className="pm-section-head">
            <span>{selected.name}</span>
            <span className="pm-muted">{tickets.length} tickets</span>
          </div>
          <SortableContext items={tickets.map((entry) => entry.ticket.id)} strategy={verticalListSortingStrategy}>
            <ul className="pm-ticket-list" aria-label={`${selected.name} tickets`}>
              {tickets.map((entry, index) => (
                <TicketRow
                  key={entry.ticket.id}
                  entry={entry}
                  showStage={showStage}
                  selected={entry.ticket.id === props.selectedTicketId}
                  onSelect={() => props.onSelectTicket(entry.ticket.id)}
                  moves={{
                    up: index > 0 ? () => props.onMoveTicket(entry.ticket.id, selected.id, index - 1) : undefined,
                    down: index < tickets.length - 1 ? () => props.onMoveTicket(entry.ticket.id, selected.id, index + 1) : undefined,
                    to: moveTargets.map((sprint) => ({ label: sprint.name, move: () => props.onMoveTicket(entry.ticket.id, sprint.id) })),
                    toNoSprint: () => props.onMoveTicket(entry.ticket.id, null),
                  }}
                />
              ))}
            </ul>
          </SortableContext>
          {selected.state !== "closed" && (
            <form
              className="pm-inline-form pm-add-ticket"
              onSubmit={(event) => {
                event.preventDefault();
                props.onCreateTicket(ticketTitle);
                setTicketTitle("");
              }}
            >
              <input placeholder="Add a ticket…" aria-label="New ticket title" value={ticketTitle} onChange={(event) => setTicketTitle(event.target.value)} />
            </form>
          )}
        </>
      )}
    </aside>
    </DndContext>
  );
}

function SprintRow(props: { sprint: PmSprint; count: number; selected: boolean; onSelect(): void }) {
  const droppable = useDroppable({ id: `${LANE_PREFIX}${props.sprint.id}`, disabled: props.sprint.state === "closed" });
  return (
    <button
      ref={droppable.setNodeRef}
      type="button"
      className={`pm-sprint-row ${props.selected ? "selected" : ""} ${droppable.isOver ? "drop-over" : ""}`}
      onClick={props.onSelect}
    >
      <span className={`pm-sprint-state ${props.sprint.state}`} />
      <span className="pm-sprint-name">{props.sprint.name}</span>
      <span className="pm-muted">{props.count}</span>
    </button>
  );
}

/** Drop target for taking a ticket out of every sprint. */
function NoSprintTarget(props: { count: number }) {
  const droppable = useDroppable({ id: NO_SPRINT });
  return (
    <div ref={droppable.setNodeRef} className={`pm-sprint-row pm-no-sprint ${droppable.isOver ? "drop-over" : ""}`} title="Drop a ticket here to take it out of its sprint">
      <span className="pm-sprint-state none" />
      <span className="pm-sprint-name">No sprint</span>
      <span className="pm-muted">{props.count}</span>
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
      <button type="button" className="pm-icon-button" aria-label={`Move ${props.title}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
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
  const risky = delivery.risks.length > 0;
  const sortable = useSortable({ id: ticket.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <li ref={sortable.setNodeRef} style={style} className={`pm-ticket-item ${sortable.isDragging ? "dragging" : ""}`}>
      <button type="button" className={`pm-ticket-row ${props.selected ? "selected" : ""}`} onClick={props.onSelect} {...sortable.listeners}>
        <span className={`pm-status-square ${ticket.status}`} aria-hidden="true" />
        <span className="pm-ticket-body">
          <span className="pm-ticket-meta">
            {ticketLabel(ticket)}{ticket.assignee ? ` · ${ticket.assignee}` : ""}
            {ticket.carryOverCount > 0 && <span className="pm-carry" title="Carried over">↻{ticket.carryOverCount}</span>}
          </span>
          <span className="pm-ticket-title">{ticket.title}</span>
          <span className="pm-ticket-pills">
            <span className={`pm-pill status-${ticket.status}`}>{STATUS_LABEL[ticket.status]}</span>
            {props.showStage && (
              <span className={`pm-pill stage stage-${delivery.stage.kind}`} data-testid="stage-pill">
                {STAGE_LABEL[delivery.stage.kind]}{delivery.stage.environment ? ` · ${delivery.stage.environment}` : ""}
              </span>
            )}
            {pendingProposalCount > 0 && <span className="pm-pill proposal">Draft</span>}
            {delivery.checking && <span className="pm-checking">checking…</span>}
          </span>
        </span>
        {risky && <span className="pm-risk-dot" title={delivery.risks.map((risk) => risk.detail).join("\n")} aria-label="Has risks" />}
      </button>
      <MoveMenu moves={props.moves} title={ticket.title} />
    </li>
  );
}
