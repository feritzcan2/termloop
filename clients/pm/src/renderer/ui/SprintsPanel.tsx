import { useState } from "react";
import type { PmBoardTicket, PmSprint } from "@termloop/pm-contract/pm";
import { Icon } from "./icons.js";
import { SprintForm } from "./SprintSidebar.js";
import { sprintDay, sprintPanelOrder, sprintStart, sprintTickets } from "./format.js";
import { useLaneDrop } from "./sprint-dnd.js";

export type SprintsPanelProps = {
  sprints: PmSprint[];
  tickets: PmBoardTicket[];
  /** The focused sprint, highlighted. */
  selectedSprintId: string | undefined;
  now: number;
  canCreate: boolean;
  onSelectSprint(sprintId: string): void;
  onActivateSprint(sprintId: string): void;
  onCreateSprint(name: string, goal: string): void;
};

const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

function doneOf(tickets: PmBoardTicket[]): string {
  return `${tickets.filter((entry) => entry.ticket.status === "done").length}/${tickets.length}`;
}

/** "Oct 13 – Oct 27 · day 9/14" style dates of a sprint row. */
export function sprintDates(sprint: PmSprint, now: number): string {
  if (sprint.state === "closed") return sprint.closedAtEpochMs !== null ? `closed ${DATE.format(sprint.closedAtEpochMs)}` : "closed";
  const start = sprint.state === "active" || sprint.activatedAtEpochMs !== null ? DATE.format(sprintStart(sprint)) : undefined;
  const end = sprint.endsAtEpochMs !== null ? DATE.format(sprint.endsAtEpochMs) : undefined;
  const range = start && end ? `${start} – ${end}` : end ? `ends ${end}` : start ? `from ${start}` : sprint.state;
  const day = sprint.state === "active" ? sprintDay(sprint, now) : undefined;
  return day ? `${range} · day ${day.day}/${day.of}` : range;
}

/** The right sidebar's "Sprints" view: every sprint of the project, each a drop target. */
export function SprintsPanel(props: SprintsPanelProps) {
  const [composing, setComposing] = useState(false);
  const ordered = sprintPanelOrder(props.sprints);
  const open = ordered.filter((sprint) => sprint.state !== "closed");
  const closed = ordered.filter((sprint) => sprint.state === "closed");
  const rowOf = (sprint: PmSprint) => (
    <SprintRow
      key={sprint.id}
      sprint={sprint}
      dates={sprintDates(sprint, props.now)}
      done={doneOf(sprintTickets(props.tickets, sprint.id))}
      selected={sprint.id === props.selectedSprintId}
      onSelect={() => props.onSelectSprint(sprint.id)}
      onActivate={() => props.onActivateSprint(sprint.id)}
    />
  );
  return (
    <div className="sprints-panel">
      <div className="right-sidebar-tools">
        <span className="count-badge" title="Sprints">{props.sprints.length}</span>
        <span className="sp" />
        <button type="button" className="view-action" disabled={!props.canCreate} onClick={() => setComposing(!composing)}>
          <Icon name="plus" />New sprint
        </button>
      </div>
      {composing && <SprintForm onCreate={(name, goal) => { props.onCreateSprint(name, goal); setComposing(false); }} onCancel={() => setComposing(false)} />}
      {props.sprints.length === 0 ? <p className="rail-empty">No sprints yet. Create one, or pull from Jira.</p> : (
        <>
          <div className="list sprint-rows" aria-label="Open sprints">
            {open.map(rowOf)}
            <NoSprintTarget count={sprintTickets(props.tickets, undefined).length} />
          </div>
          {closed.length > 0 && (
            <>
              <div className="rail-subhead">Closed</div>
              <div className="list" aria-label="Closed sprints">{closed.map(rowOf)}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function SprintRow(props: { sprint: PmSprint; dates: string; done: string; selected: boolean; onSelect(): void; onActivate(): void }) {
  const { sprint } = props;
  const droppable = useLaneDrop(sprint.id, sprint.state === "closed");
  const activatable = sprint.state === "planned" || sprint.state === "backlog";
  return (
    <div ref={droppable.setNodeRef} className={`pm-sprint-item ${droppable.isOver ? "drop-over" : ""}`}>
      <button
        type="button"
        className={`row sprint-row ${props.selected ? "active" : ""}`}
        data-state={sprint.state}
        aria-current={props.selected ? "true" : undefined}
        onClick={props.onSelect}
      >
        <span className="sq" />
        <span className="copy">
          <span className="row-title">{sprint.name}</span>
          <span className="row-sub"><span>{props.dates}</span></span>
        </span>
        <span className="done">{props.done}</span>
      </button>
      {activatable && (
        <button type="button" className="btn sm ghost pm-activate" title={`Make ${sprint.name} the active sprint`} onClick={props.onActivate}>
          Activate
        </button>
      )}
    </div>
  );
}

/** Drop target for taking a ticket out of every sprint. */
function NoSprintTarget(props: { count: number }) {
  const droppable = useLaneDrop(null);
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
