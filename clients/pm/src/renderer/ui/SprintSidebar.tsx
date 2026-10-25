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
};

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
  return (
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
                <button
                  type="button"
                  key={sprint.id}
                  className={`pm-sprint-row ${sprint.id === props.selectedSprintId ? "selected" : ""}`}
                  onClick={() => props.onSelectSprint(sprint.id)}
                >
                  <span className={`pm-sprint-state ${sprint.state}`} />
                  <span className="pm-sprint-name">{sprint.name}</span>
                  <span className="pm-muted">{sprintTickets(props.tickets, sprint.id).length}</span>
                </button>
              ))}
            </div>
          );
        })}
        {props.sprints.length === 0 && <p className="pm-hint">No sprints yet. Create one with +, or pull from Jira.</p>}
      </div>
      {selected && (
        <>
          <div className="pm-section-head">
            <span>{selected.name}</span>
            <span className="pm-muted">{tickets.length} tickets</span>
          </div>
          <ul className="pm-ticket-list" aria-label={`${selected.name} tickets`}>
            {tickets.map((entry) => (
              <TicketRow
                key={entry.ticket.id}
                entry={entry}
                showStage={showStage}
                selected={entry.ticket.id === props.selectedTicketId}
                onSelect={() => props.onSelectTicket(entry.ticket.id)}
              />
            ))}
          </ul>
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
  );
}

function TicketRow(props: { entry: PmBoardTicket; showStage: boolean; selected: boolean; onSelect(): void }) {
  const { ticket, delivery, pendingProposalCount } = props.entry;
  const risky = delivery.risks.length > 0;
  return (
    <li>
      <button type="button" className={`pm-ticket-row ${props.selected ? "selected" : ""}`} onClick={props.onSelect}>
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
    </li>
  );
}
