//! Agent proposals: an agent suggests a ticket change, the PM accepts or
//! rejects it. Only an accepted proposal changes the ticket, and a
//! description proposal then becomes the next version, authored by the
//! agent. A skill's proposal also records the PM's verdict as feedback for
//! that skill and manifest version.

use rusqlite::{Connection, params};

use super::skill::record_feedback;
use super::ticket::{
    add_blocker, check_target_sprint, move_ticket, record_version, set_ticket_column,
};
use super::{check_id, require_ticket, touch_ticket};
use crate::proposal::{TICKET_JIRA_COMMENTS_MAX, TICKET_PROPOSALS_MAX, valid_proposal_summary};
use crate::skill::{
    Evidence, FeedbackOutcome, SKILL_FEEDBACK_REASON_MAX_CHARS, evidence_key, valid_evidence,
};
use crate::store::{evidence_rejected, proposal_by_id, ticket_proposals, to_json};
use crate::ticket::{TICKET_BLOCKERS_MAX, TICKET_CRITERIA_MAX};
use crate::validation::valid_label;
use crate::{
    Blocker, PmError, PmStore, ProposalChange, Ticket, TicketActivityKind, TicketAuthor,
    TicketProposal, valid_id,
};

/// The skill a proposal comes from, with the evidence it rests on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalOrigin {
    pub skill_id: String,
    pub skill_version: u32,
    pub evidence: Vec<Evidence>,
}

fn require_proposal(connection: &Connection, proposal_id: &str) -> Result<TicketProposal, PmError> {
    check_id(proposal_id, "proposalId")?;
    proposal_by_id(connection, proposal_id)?.ok_or(PmError::NotFound)
}

/// The items of `proposed` the ticket does not hold yet, in order.
fn new_items<'a>(existing: &[&str], proposed: &'a [String]) -> Vec<&'a String> {
    proposed
        .iter()
        .filter(|text| !existing.contains(&text.as_str()))
        .collect()
}

fn criteria_texts(ticket: &Ticket) -> Vec<&str> {
    ticket
        .acceptance_criteria
        .iter()
        .map(|criterion| criterion.text.as_str())
        .collect()
}

fn blocker_texts(ticket: &Ticket) -> Vec<&str> {
    ticket
        .blockers
        .iter()
        .map(|blocker| blocker.text.as_str())
        .collect()
}

/// Whether the change would leave the ticket as it is.
fn changes_nothing(ticket: &Ticket, change: &ProposalChange) -> bool {
    match change {
        ProposalChange::Description { description } => *description == ticket.description,
        ProposalChange::AcceptanceCriteria { criteria } => {
            new_items(&criteria_texts(ticket), criteria).is_empty()
        }
        ProposalChange::Blockers { blockers } => {
            new_items(&blocker_texts(ticket), blockers).is_empty()
        }
        ProposalChange::Status { status } => *status == ticket.status,
        ProposalChange::Assignee { assignee, .. } => ticket.assignee.as_ref() == Some(assignee),
        ProposalChange::Sprint { sprint_id } => ticket.sprint_id == *sprint_id,
        ProposalChange::JiraComment { .. } => false,
    }
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
        self.propose_ticket_change_from(ticket_id, change, summary, None)
    }

    /// Records a proposal, from a skill when `origin` names one. An
    /// assistant description proposal replaces the assistant's pending one
    /// for the same ticket. A skill's
    /// suggestion the PM already rejected on the same evidence is refused,
    /// and so is a Jira comment for a ticket without a Jira issue.
    pub fn propose_ticket_change_from(
        &mut self,
        ticket_id: &str,
        change: ProposalChange,
        summary: &str,
        origin: Option<ProposalOrigin>,
    ) -> Result<TicketProposal, PmError> {
        if !change.is_valid() {
            return Err(PmError::Invalid(change.parameter()));
        }
        if !valid_proposal_summary(summary) {
            return Err(PmError::Invalid("summary"));
        }
        if let Some(origin) = &origin
            && (!valid_id(&origin.skill_id)
                || origin.skill_version == 0
                || !valid_evidence(&origin.evidence))
        {
            return Err(PmError::Invalid("evidence"));
        }
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, ticket_id)?;
            if changes_nothing(&ticket, &change) {
                return Err(PmError::Constraint("the proposal changes nothing"));
            }
            if matches!(change, ProposalChange::JiraComment { .. })
                && ticket.jira_issue_key().is_none()
            {
                return Err(PmError::Constraint(
                    "the ticket is not linked to a Jira issue",
                ));
            }
            if let ProposalChange::Sprint {
                sprint_id: Some(sprint_id),
            } = &change
            {
                check_target_sprint(transaction, &ticket.project_id, Some(sprint_id))?;
            }
            // The assistant keeps one description draft per ticket: a newer
            // one, merging newer notes, replaces its older pending draft.
            if origin.is_none() && matches!(change, ProposalChange::Description { .. }) {
                transaction.execute(
                    "DELETE FROM ticket_proposals \
                     WHERE ticket_id = ?1 AND kind = 'description' AND skill_id IS NULL",
                    [ticket_id],
                )?;
            }
            if ticket_proposals(transaction, ticket_id)?.len() >= TICKET_PROPOSALS_MAX {
                return Err(PmError::Constraint("too many pending proposals"));
            }
            let key = origin
                .as_ref()
                .and_then(|origin| evidence_key(ticket_id, change.kind(), &origin.evidence));
            if let (Some(origin), Some(key)) = (&origin, &key)
                && evidence_rejected(transaction, &origin.skill_id, key)?
            {
                return Err(PmError::Constraint(
                    "the project manager rejected this suggestion on the same evidence",
                ));
            }
            let (skill_id, skill_version, evidence) = match origin {
                Some(origin) => (
                    Some(origin.skill_id),
                    Some(origin.skill_version),
                    origin.evidence,
                ),
                None => (None, None, Vec::new()),
            };
            let proposal = TicketProposal {
                id,
                ticket_id: ticket_id.to_owned(),
                change,
                summary: summary.to_owned(),
                base_version: ticket.versions.as_ref().map_or(0, |head| head.head_number),
                skill_id,
                skill_version,
                evidence,
                created_at_epoch_ms: now,
            };
            transaction.execute(
                "INSERT INTO ticket_proposals (id, ticket_id, kind, change_json, summary, \
                     base_version, skill_id, skill_version, evidence_json, evidence_key, \
                     created_at_epoch_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    proposal.id,
                    proposal.ticket_id,
                    proposal.change.kind(),
                    to_json(&proposal.change)?,
                    proposal.summary,
                    proposal.base_version,
                    proposal.skill_id,
                    proposal.skill_version,
                    to_json(&proposal.evidence)?,
                    key,
                    proposal.created_at_epoch_ms
                ],
            )?;
            Ok(proposal)
        })
    }

    /// The PM accepts a proposal. A description becomes the ticket's next
    /// version, authored by the agent, but only while the version it was
    /// proposed against is still the newest (otherwise a conflict, and the
    /// proposal stays). Criteria and blockers the ticket lacks are added; a
    /// status, assignee, or sprint is set; a Jira comment waits for the
    /// confirmed Jira write. `assignee` picks another person of an assignee
    /// suggestion's shortlist. The proposal is then removed.
    pub fn accept_ticket_proposal(&mut self, proposal_id: &str) -> Result<Ticket, PmError> {
        self.accept_ticket_proposal_as(proposal_id, None)
    }

    pub fn accept_ticket_proposal_as(
        &mut self,
        proposal_id: &str,
        assignee: Option<&str>,
    ) -> Result<Ticket, PmError> {
        let ids = self.id_source();
        let now = self.now();
        self.write(|transaction| {
            let proposal = require_proposal(transaction, proposal_id)?;
            let ticket = require_ticket(transaction, &proposal.ticket_id)?;
            if assignee.is_some() && !matches!(proposal.change, ProposalChange::Assignee { .. }) {
                return Err(PmError::Invalid("assignee"));
            }
            apply_change(transaction, &proposal, &ticket, assignee, ids, now)?;
            transaction.execute("DELETE FROM ticket_proposals WHERE id = ?1", [proposal_id])?;
            record_feedback(transaction, &proposal, FeedbackOutcome::Accepted, None, now)?;
            require_ticket(transaction, &ticket.id)
        })
    }

    /// The PM turns a proposal down; it is removed and the ticket is left
    /// alone. A skill's suggestion keeps the optional reason as feedback.
    pub fn reject_ticket_proposal(&mut self, proposal_id: &str) -> Result<(), PmError> {
        self.reject_ticket_proposal_because(proposal_id, None)
    }

    pub fn reject_ticket_proposal_because(
        &mut self,
        proposal_id: &str,
        reason: Option<&str>,
    ) -> Result<(), PmError> {
        if reason.is_some_and(|reason| !valid_label(reason, SKILL_FEEDBACK_REASON_MAX_CHARS)) {
            return Err(PmError::Invalid("reason"));
        }
        let now = self.now();
        self.write(|transaction| {
            let proposal = require_proposal(transaction, proposal_id)?;
            transaction.execute("DELETE FROM ticket_proposals WHERE id = ?1", [proposal_id])?;
            record_feedback(
                transaction,
                &proposal,
                FeedbackOutcome::Rejected,
                reason,
                now,
            )
        })
    }

    /// A ticket's pending proposals, oldest first.
    pub fn ticket_proposals(&self, ticket_id: &str) -> Result<Vec<TicketProposal>, PmError> {
        check_id(ticket_id, "ticketId")?;
        ticket_proposals(self.connection(), ticket_id)
    }

    /// The pending proposals of a project's skills, by ticket then age.
    pub fn skill_suggestions(&self, project_id: &str) -> Result<Vec<TicketProposal>, PmError> {
        check_id(project_id, "projectId")?;
        let mut statement = self.connection().prepare(
            "SELECT p.id FROM ticket_proposals p JOIN tickets t ON t.id = p.ticket_id \
             WHERE t.project_id = ?1 AND p.skill_id IS NOT NULL \
             ORDER BY t.rank, t.id, p.created_at_epoch_ms, p.id",
        )?;
        let ids = statement
            .query_map([project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| require_proposal(self.connection(), id))
            .collect()
    }
}

fn apply_change(
    transaction: &Connection,
    proposal: &TicketProposal,
    ticket: &Ticket,
    chosen_assignee: Option<&str>,
    ids: fn() -> String,
    now: u64,
) -> Result<(), PmError> {
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
            let added = new_items(&criteria_texts(ticket), criteria);
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
        ProposalChange::Blockers { blockers } => {
            let added = new_items(&blocker_texts(ticket), blockers);
            if ticket.blockers.len() + added.len() > TICKET_BLOCKERS_MAX {
                return Err(PmError::Constraint("too many blockers"));
            }
            for text in added {
                let blocker = Blocker {
                    id: ids(),
                    text: text.clone(),
                };
                add_blocker(transaction, &ticket.id, &blocker, now)?;
            }
        }
        ProposalChange::Status { status } => {
            set_ticket_column(
                transaction,
                &ticket.id,
                "status",
                Some(status.as_str()),
                Some(TicketActivityKind::Status),
                now,
            )?;
        }
        ProposalChange::Assignee {
            assignee,
            shortlist,
        } => {
            let chosen = match chosen_assignee {
                None => assignee.as_str(),
                Some(name) if shortlist.iter().any(|candidate| candidate.name == name) => name,
                Some(_) => return Err(PmError::Invalid("assignee")),
            };
            set_ticket_column(
                transaction,
                &ticket.id,
                "assignee",
                Some(chosen),
                Some(TicketActivityKind::Assignee),
                now,
            )?;
        }
        ProposalChange::Sprint { sprint_id } => {
            move_ticket(transaction, &ticket.id, sprint_id.as_deref(), now)?;
        }
        ProposalChange::JiraComment { body } => {
            if ticket.jira_issue_key().is_none() {
                return Err(PmError::Constraint(
                    "the ticket is not linked to a Jira issue",
                ));
            }
            let queued: usize = transaction.query_row(
                "SELECT COUNT(*) FROM ticket_jira_comments WHERE ticket_id = ?1",
                [&ticket.id],
                |row| row.get(0),
            )?;
            if queued >= TICKET_JIRA_COMMENTS_MAX {
                return Err(PmError::Constraint(
                    "too many comments wait for the Jira write",
                ));
            }
            transaction.execute(
                "INSERT INTO ticket_jira_comments (id, ticket_id, body, queued_at_epoch_ms) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![ids(), ticket.id, body, now],
            )?;
        }
    }
    Ok(())
}
