//! Agent proposals: an agent suggests a ticket change, the PM accepts or
//! rejects it. Only an accepted proposal changes the ticket, and a
//! description proposal then becomes the next version, authored by the
//! agent.

use rusqlite::{Connection, params};

use super::ticket::record_version;
use super::{check_id, require_ticket, touch_ticket};
use crate::proposal::{TICKET_PROPOSALS_MAX, valid_proposal_summary};
use crate::store::{proposal_by_id, ticket_proposals, to_json};
use crate::ticket::TICKET_CRITERIA_MAX;
use crate::{PmError, PmStore, ProposalChange, Ticket, TicketAuthor, TicketProposal};

fn require_proposal(connection: &Connection, proposal_id: &str) -> Result<TicketProposal, PmError> {
    check_id(proposal_id, "proposalId")?;
    proposal_by_id(connection, proposal_id)?.ok_or(PmError::NotFound)
}

/// The criteria of `proposed` the ticket does not have yet, in order.
fn new_criteria<'a>(ticket: &Ticket, proposed: &'a [String]) -> Vec<&'a String> {
    proposed
        .iter()
        .filter(|text| {
            !ticket
                .acceptance_criteria
                .iter()
                .any(|criterion| criterion.text == **text)
        })
        .collect()
}

impl PmStore {
    /// Records an agent's proposed ticket change; the ticket itself is left
    /// alone. A proposal that would change nothing is refused.
    pub fn propose_ticket_change(
        &mut self,
        ticket_id: &str,
        change: ProposalChange,
        summary: &str,
    ) -> Result<TicketProposal, PmError> {
        if !change.is_valid() {
            return Err(PmError::Invalid(match change {
                ProposalChange::Description { .. } => "description",
                ProposalChange::AcceptanceCriteria { .. } => "criteria",
            }));
        }
        if !valid_proposal_summary(summary) {
            return Err(PmError::Invalid("summary"));
        }
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, ticket_id)?;
            let unchanged = match &change {
                ProposalChange::Description { description } => *description == ticket.description,
                ProposalChange::AcceptanceCriteria { criteria } => {
                    new_criteria(&ticket, criteria).is_empty()
                }
            };
            if unchanged {
                return Err(PmError::Constraint("the proposal changes nothing"));
            }
            if ticket_proposals(transaction, ticket_id)?.len() >= TICKET_PROPOSALS_MAX {
                return Err(PmError::Constraint("too many pending proposals"));
            }
            let proposal = TicketProposal {
                id,
                ticket_id: ticket_id.to_owned(),
                change,
                summary: summary.to_owned(),
                base_version: ticket.versions.as_ref().map_or(0, |head| head.head_number),
                created_at_epoch_ms: now,
            };
            let (description, criteria_json) = match &proposal.change {
                ProposalChange::Description { description } => (Some(description.clone()), None),
                ProposalChange::AcceptanceCriteria { criteria } => (None, Some(to_json(criteria)?)),
            };
            transaction.execute(
                "INSERT INTO ticket_proposals (id, ticket_id, kind, description, criteria_json, \
                     summary, base_version, created_at_epoch_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    proposal.id,
                    proposal.ticket_id,
                    proposal.change.kind(),
                    description,
                    criteria_json,
                    proposal.summary,
                    proposal.base_version,
                    proposal.created_at_epoch_ms
                ],
            )?;
            Ok(proposal)
        })
    }

    /// The PM accepts a proposal. A description becomes the ticket's next
    /// version, authored by the agent, but only while the version it was
    /// proposed against is still the newest (otherwise a conflict, and the
    /// proposal stays). Criteria the ticket lacks are added. The proposal is
    /// then removed.
    pub fn accept_ticket_proposal(&mut self, proposal_id: &str) -> Result<Ticket, PmError> {
        let ids = self.id_source();
        let now = self.now();
        self.write(|transaction| {
            let proposal = require_proposal(transaction, proposal_id)?;
            let ticket = require_ticket(transaction, &proposal.ticket_id)?;
            match &proposal.change {
                ProposalChange::Description { description } => {
                    record_version(
                        transaction,
                        &ticket.id,
                        description,
                        TicketAuthor::Agent,
                        Some(proposal.base_version),
                        now,
                    )?;
                }
                ProposalChange::AcceptanceCriteria { criteria } => {
                    let added = new_criteria(&ticket, criteria);
                    if ticket.acceptance_criteria.len() + added.len() > TICKET_CRITERIA_MAX {
                        return Err(PmError::Constraint("too many acceptance criteria"));
                    }
                    for text in added {
                        transaction.execute(
                            "INSERT INTO ticket_criteria (id, ticket_id, position, text, done) \
                             VALUES (?1, ?2, \
                                 (SELECT COALESCE(MAX(position) + 1, 0) FROM ticket_criteria \
                                  WHERE ticket_id = ?2), ?3, 0)",
                            params![ids(), ticket.id, text],
                        )?;
                    }
                    touch_ticket(transaction, &ticket.id, now)?;
                }
            }
            transaction.execute("DELETE FROM ticket_proposals WHERE id = ?1", [proposal_id])?;
            require_ticket(transaction, &ticket.id)
        })
    }

    /// The PM turns a proposal down; it is removed and the ticket is left
    /// alone.
    pub fn reject_ticket_proposal(&mut self, proposal_id: &str) -> Result<(), PmError> {
        self.write(|transaction| {
            require_proposal(transaction, proposal_id)?;
            transaction.execute("DELETE FROM ticket_proposals WHERE id = ?1", [proposal_id])?;
            Ok(())
        })
    }

    /// A ticket's pending proposals, oldest first.
    pub fn ticket_proposals(&self, ticket_id: &str) -> Result<Vec<TicketProposal>, PmError> {
        check_id(ticket_id, "ticketId")?;
        ticket_proposals(self.connection(), ticket_id)
    }
}
