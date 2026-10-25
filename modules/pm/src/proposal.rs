//! Ticket proposals: a change an agent suggested for a ticket. A proposal is
//! never a description version; it waits until the PM accepts it (it then
//! becomes the next version, authored by the agent) or rejects it.

use crate::ticket::{TICKET_CRITERIA_MAX, valid_ticket_description, valid_ticket_item};
use crate::validation::{valid_id, valid_label};

/// Pending proposals one ticket may hold at once.
pub const TICKET_PROPOSALS_MAX: usize = 8;
pub const PROPOSAL_SUMMARY_MAX_CHARS: usize = 300;

/// What a proposal would change.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProposalChange {
    /// The complete proposed description, replacing the current one.
    Description { description: String },
    /// Acceptance criteria to add; criteria the ticket already has are
    /// kept as they are.
    #[serde(rename_all = "camelCase")]
    AcceptanceCriteria { criteria: Vec<String> },
}

impl ProposalChange {
    pub(crate) const fn kind(&self) -> &'static str {
        match self {
            Self::Description { .. } => "description",
            Self::AcceptanceCriteria { .. } => "acceptanceCriteria",
        }
    }

    pub fn is_valid(&self) -> bool {
        match self {
            Self::Description { description } => valid_ticket_description(description),
            Self::AcceptanceCriteria { criteria } => {
                !criteria.is_empty()
                    && criteria.len() <= TICKET_CRITERIA_MAX
                    && criteria.iter().enumerate().all(|(index, text)| {
                        valid_ticket_item(text) && !criteria[index + 1..].contains(text)
                    })
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TicketProposal {
    pub id: String,
    pub ticket_id: String,
    pub change: ProposalChange,
    /// One line on what changes and why.
    pub summary: String,
    /// The description version the proposal was made against (0 for none).
    /// A description proposal is accepted only while it is still the head.
    pub base_version: u64,
    pub created_at_epoch_ms: u64,
}

impl TicketProposal {
    pub fn is_valid(&self) -> bool {
        valid_id(&self.id)
            && valid_id(&self.ticket_id)
            && valid_proposal_summary(&self.summary)
            && self.change.is_valid()
    }
}

pub fn valid_proposal_summary(summary: &str) -> bool {
    valid_label(summary, PROPOSAL_SUMMARY_MAX_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn criteria_proposals_are_non_empty_unique_and_trimmed() {
        let criteria = |items: &[&str]| ProposalChange::AcceptanceCriteria {
            criteria: items.iter().map(|item| (*item).to_owned()).collect(),
        };
        assert!(criteria(&["Logs in", "Logs out"]).is_valid());
        assert!(!criteria(&[]).is_valid());
        assert!(!criteria(&["Logs in", "Logs in"]).is_valid());
        assert!(!criteria(&[" padded"]).is_valid());
        assert!(
            ProposalChange::Description {
                description: "## Goal".into()
            }
            .is_valid()
        );
        assert!(valid_proposal_summary("Clarify scope"));
        assert!(!valid_proposal_summary("two\nlines"));
    }
}
