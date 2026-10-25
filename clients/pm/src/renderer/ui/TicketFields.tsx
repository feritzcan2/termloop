import { useEffect, useState, type ReactNode } from "react";
import type { PmDataTier, PmSprint, PmTicket, PmTicketDelivery, PmTicketPriority, PmTicketStatus } from "@termloop/pm-contract/pm";
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  STAGE_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  relativeTime,
  tierAtLeast,
} from "./format.js";
import { SOURCE_LABEL, pullRequestLine } from "./delivery-facts.js";
import { assigneeUpdate, jiraUrlUpdate, sprintChoices, type TicketFieldUpdate } from "./ticket-edit.js";

export type TicketFieldsProps = {
  ticket: PmTicket;
  delivery: PmTicketDelivery;
  sprints: PmSprint[];
  tier: PmDataTier;
  now: number;
  onUpdate(fields: TicketFieldUpdate): void;
  /** Moves the ticket to a sprint, or the backlog for `null`. */
  onMoveSprint(sprintId: string | null): void;
  /** Buttons at the end of the chip row. */
  actions?: ReactNode;
};

/**
 * The ticket's field chips: status, priority, assignee, sprint, and Jira link
 * are editable; delivery stage and pull requests are read from facts. Each
 * change is one update; free text is committed when it loses focus.
 */
export function TicketFields({ ticket, delivery, sprints, tier, now, onUpdate, onMoveSprint, actions }: TicketFieldsProps) {
  const [assignee, setAssignee] = useState(ticket.assignee ?? "");
  const [jiraUrl, setJiraUrl] = useState(ticket.jiraUrl ?? "");
  const [jiraInvalid, setJiraInvalid] = useState(false);
  useEffect(() => setAssignee(ticket.assignee ?? ""), [ticket.id, ticket.assignee]);
  useEffect(() => { setJiraUrl(ticket.jiraUrl ?? ""); setJiraInvalid(false); }, [ticket.id, ticket.jiraUrl]);
  const showCode = tierAtLeast(tier, "code");
  const facts = delivery.facts;
  const pullRequests = showCode && facts ? pullRequestLine(facts, delivery.risks) : undefined;
  const commitJira = () => {
    const update = jiraUrlUpdate(jiraUrl, ticket);
    setJiraInvalid(update === "invalid");
    if (update && update !== "invalid") onUpdate(update);
  };

  return (
    <>
      <div className="chips" aria-label="Ticket fields">
        <label className={`chip-control status-${ticket.status}`}>
          <i className="swatch" />
          <select aria-label="Status" value={ticket.status} onChange={(event) => onUpdate({ status: event.target.value as PmTicketStatus })}>
            {STATUS_ORDER.map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
          </select>
        </label>
        <label className="chip-control">
          <select aria-label="Priority" value={ticket.priority} onChange={(event) => onUpdate({ priority: event.target.value as PmTicketPriority })}>
            {PRIORITY_ORDER.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}
          </select>
        </label>
        <label className="chip-control">
          <input
            aria-label="Assignee"
            className="chip-input"
            value={assignee}
            placeholder="Unassigned"
            maxLength={120}
            size={Math.max(8, assignee.length + 1)}
            onChange={(event) => setAssignee(event.target.value)}
            onBlur={() => { const update = assigneeUpdate(assignee, ticket); if (update) onUpdate(update); }}
          />
        </label>
        <label className="chip-control">
          <select aria-label="Sprint" value={ticket.sprintId ?? ""} onChange={(event) => onMoveSprint(event.target.value || null)}>
            <option value="">Backlog</option>
            {sprintChoices(sprints, ticket.sprintId).map((sprint) => (
              <option key={sprint.id} value={sprint.id}>{sprint.name}{sprint.state === "active" ? " · active" : sprint.state === "closed" ? " · closed" : ""}</option>
            ))}
          </select>
        </label>
        {ticket.blockers.length > 0 && <span className="chip-static bad">Blocked · {ticket.blockers[0]!.text}{ticket.blockers.length > 1 ? ` +${ticket.blockers.length - 1}` : ""}</span>}
        {showCode && <span className="chip-static">{STAGE_LABEL[delivery.stage.kind]}{delivery.stage.environment ? ` · ${delivery.stage.environment}` : ""}</span>}
        {ticket.carryOverCount > 0 && <span className="chip-static">Carried over ×{ticket.carryOverCount}</span>}
        <span className="sp" />
        {actions}
      </div>
      <dl className="props">
        <div>
          <dt>Jira issue</dt>
          <dd>
            <input
              aria-label="Jira issue link"
              aria-invalid={jiraInvalid}
              className={jiraInvalid ? "invalid" : ""}
              value={jiraUrl}
              placeholder="https://site.atlassian.net/browse/KEY-1"
              maxLength={2048}
              onChange={(event) => { setJiraUrl(event.target.value); setJiraInvalid(false); }}
              onBlur={commitJira}
              onKeyDown={(event) => { if (event.key === "Enter") commitJira(); }}
            />
            {jiraInvalid && <span className="hint error">Use the issue's browse link, like https://site.atlassian.net/browse/KEY-1.</span>}
          </dd>
        </div>
        {facts?.jiraStatus && (
          <div>
            <dt>In Jira</dt>
            <dd>{facts.jiraStatus} · {facts.jiraAssignee ?? "Unassigned"}</dd>
          </div>
        )}
        {pullRequests && (
          <div>
            <dt>Pull requests</dt>
            <dd className={pullRequests.unavailable ? "warning" : undefined} data-testid="pr-line">{pullRequests.text}</dd>
          </div>
        )}
        {showCode && facts && facts.deployedEnvironments.length > 0 && (
          <div>
            <dt>Deployed to</dt>
            <dd>{facts.deployedEnvironments.join(", ")}</dd>
          </div>
        )}
        {facts && (
          <div>
            <dt>Facts read</dt>
            <dd className={facts.stale || facts.failedReads.length > 0 ? "warning" : "muted"}>
              {relativeTime(facts.recordedAtEpochMs, now)}
              {facts.stale ? " · stale" : ""}
              {facts.failedReads.length > 0 ? ` · could not read ${facts.failedReads.map((source) => SOURCE_LABEL[source]).join(", ")}` : ""}
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}
