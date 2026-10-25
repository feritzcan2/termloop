import type { PmBoardTicket, PmProposal, PmSkill, PmSprint, PmTicket } from "@termloop/pm-contract/pm";
import { ProposalCard } from "./ProposalCard.js";
import { useMemo } from "react";
import { sprintName, ticketLabel } from "./format.js";

export type SuggestionsPanelProps = {
  /** The project's pending skill suggestions, by ticket then age; `undefined` while loading. */
  suggestions: PmProposal[] | undefined;
  tickets: PmBoardTicket[];
  sprints: PmSprint[];
  skills: PmSkill[];
  now: number;
  onAccept(ticketId: string, proposalId: string, assignee?: string): void;
  onReject(ticketId: string, proposalId: string): void;
  onAcceptAll(ticketId: string): void;
  onOpenTicket(ticketId: string): void;
  onOpenLink(url: string): void;
};

/**
 * The right sidebar's "Suggestions" view: every skill suggestion waiting for
 * the PM, grouped by ticket and tagged with the skill that made it. Nothing
 * changes until the PM accepts; Jira changes only from "Write to Jira…".
 */
export function SuggestionsPanel(props: SuggestionsPanelProps) {
  const groups = useMemo(() => byTicket(props.suggestions ?? [], props.tickets), [props.suggestions, props.tickets]);
  const skillNames = useMemo(() => new Map(props.skills.map((skill) => [skill.id, skill.manifest.name])), [props.skills]);
  const shown = groups.reduce((count, group) => count + group.proposals.length, 0);
  return (
    <div className="suggestions-panel">
      <div className="right-sidebar-tools">
        <span className="count-badge" title="Suggestions">{shown}</span>
      </div>
      {props.suggestions === undefined ? (
        <p className="hint pad">Loading suggestions…</p>
      ) : groups.length === 0 ? (
        <div className="empty-state pad">
          <p>No suggestions waiting.</p>
          <p className="hint">Skills you turned on suggest ticket changes here for you to accept or reject.</p>
        </div>
      ) : (
        groups.map(({ ticket, proposals }) => (
          <section key={ticket.id} className="suggestion-group" aria-label={`Suggestions for ${ticketLabel(ticket)}`}>
            <header className="suggestion-group-head">
              <button type="button" className="link" title="Open ticket" onClick={() => props.onOpenTicket(ticket.id)}>{ticketLabel(ticket)}</button>
              <span className="suggestion-title">{ticket.title}</span>
              <span className="sp" />
              {proposals.length > 1 && (
                <button type="button" className="btn sm" onClick={() => props.onAcceptAll(ticket.id)}>Accept all {proposals.length}</button>
              )}
            </header>
            {proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                ticket={ticket}
                headVersion={ticket.versions?.headNumber ?? 0}
                now={props.now}
                source={skillNames.get(proposal.skillId ?? "") ?? "Skill"}
                sprintName={(sprintId) => sprintName(props.sprints, sprintId)}
                onAccept={(assignee) => props.onAccept(ticket.id, proposal.id, assignee)}
                onReject={() => props.onReject(ticket.id, proposal.id)}
                onOpenLink={props.onOpenLink}
              />
            ))}
          </section>
        ))
      )}
    </div>
  );
}

/** The suggestions of each ticket on the board, tickets in first-seen order. */
function byTicket(proposals: PmProposal[], tickets: PmBoardTicket[]): { ticket: PmTicket; proposals: PmProposal[] }[] {
  const board = new Map(tickets.map((entry) => [entry.ticket.id, entry.ticket]));
  const groups = new Map<string, { ticket: PmTicket; proposals: PmProposal[] }>();
  for (const proposal of proposals) {
    const ticket = board.get(proposal.ticketId);
    if (!ticket) continue;
    const group = groups.get(ticket.id);
    if (group) group.proposals.push(proposal);
    else groups.set(ticket.id, { ticket, proposals: [proposal] });
  }
  return [...groups.values()];
}
