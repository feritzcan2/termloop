//! Ticket proposals: a change an agent suggested for a ticket. A proposal is
//! never a description version; it waits until the PM accepts it (it then
//! becomes the next version, authored by the agent) or rejects it. A
//! proposal a skill made names the skill, its manifest version, and the
//! evidence it rests on.

use crate::skill::{EVIDENCE_LABEL_MAX_CHARS, Evidence, valid_evidence};
use crate::ticket::{
    TICKET_BLOCKERS_MAX, TICKET_CRITERIA_MAX, TicketStatus, valid_assignee,
    valid_ticket_description, valid_ticket_item,
};
use crate::validation::{valid_id, valid_label, valid_non_blank_text};

/// Pending proposals one ticket may hold at once.
pub const TICKET_PROPOSALS_MAX: usize = 8;
pub const PROPOSAL_SUMMARY_MAX_CHARS: usize = 300;
/// People an assignee suggestion ranks.
pub const ASSIGNEE_SHORTLIST_MAX: usize = 3;
pub const JIRA_COMMENT_MAX_CHARS: usize = 4_000;
/// Accepted comments one ticket may hold until the Jira write.
pub const TICKET_JIRA_COMMENTS_MAX: usize = 8;

/// One person an assignee suggestion ranks, with why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AssigneeCandidate {
    pub name: String,
    /// One line on why this person.
    pub reason: String,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

/// What a proposal would change.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProposalChange {
    /// The complete proposed description, replacing the current one.
    Description {
        description: String,
    },
    /// Acceptance criteria to add; criteria the ticket already has are
    /// kept as they are.
    #[serde(rename_all = "camelCase")]
    AcceptanceCriteria {
        criteria: Vec<String>,
    },
    /// Blockers to add; blockers the ticket already has are kept.
    Blockers {
        blockers: Vec<String>,
    },
    Status {
        status: TicketStatus,
    },
    /// The first of the shortlist, best first; the PM may pick another.
    Assignee {
        assignee: String,
        shortlist: Vec<AssigneeCandidate>,
    },
    /// An open sprint of the ticket's project, or the backlog for `None`.
    #[serde(rename_all = "camelCase")]
    Sprint {
        sprint_id: Option<String>,
    },
    /// A comment for the linked Jira issue; accepted, it waits in the
    /// "Write to Jira" diff for the PM's confirmation.
    JiraComment {
        body: String,
    },
}

impl ProposalChange {
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Description { .. } => "description",
            Self::AcceptanceCriteria { .. } => "acceptanceCriteria",
            Self::Blockers { .. } => "blockers",
            Self::Status { .. } => "status",
            Self::Assignee { .. } => "assignee",
            Self::Sprint { .. } => "sprint",
            Self::JiraComment { .. } => "jiraComment",
        }
    }

    /// The parameter a refused change names.
    pub(crate) const fn parameter(&self) -> &'static str {
        match self {
            Self::Description { .. } => "description",
            Self::AcceptanceCriteria { .. } => "criteria",
            Self::Blockers { .. } => "blockers",
            Self::Status { .. } => "status",
            Self::Assignee { .. } => "assignee",
            Self::Sprint { .. } => "sprintId",
            Self::JiraComment { .. } => "body",
        }
    }

    pub fn is_valid(&self) -> bool {
        match self {
            Self::Description { description } => valid_ticket_description(description),
            Self::AcceptanceCriteria { criteria } => valid_items(criteria, TICKET_CRITERIA_MAX),
            Self::Blockers { blockers } => valid_items(blockers, TICKET_BLOCKERS_MAX),
            Self::Status { .. } => true,
            Self::Assignee {
                assignee,
                shortlist,
            } => {
                valid_assignee(assignee)
                    && shortlist.len() <= ASSIGNEE_SHORTLIST_MAX
                    && shortlist
                        .first()
                        .is_none_or(|first| first.name == *assignee)
                    && shortlist.iter().enumerate().all(|(index, candidate)| {
                        valid_assignee(&candidate.name)
                            && valid_label(&candidate.reason, EVIDENCE_LABEL_MAX_CHARS)
                            && valid_evidence(&candidate.evidence)
                            && !shortlist[index + 1..]
                                .iter()
                                .any(|other| other.name == candidate.name)
                    })
            }
            Self::Sprint { sprint_id } => sprint_id.as_deref().is_none_or(valid_id),
            Self::JiraComment { body } => valid_non_blank_text(body, JIRA_COMMENT_MAX_CHARS),
        }
    }
}

fn valid_items(items: &[String], max: usize) -> bool {
    !items.is_empty()
        && items.len() <= max
        && items
            .iter()
            .enumerate()
            .all(|(index, text)| valid_ticket_item(text) && !items[index + 1..].contains(text))
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
    /// The skill that suggested it; `None` for the assistant.
    #[serde(default)]
    pub skill_id: Option<String>,
    #[serde(default)]
    pub skill_version: Option<u32>,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    pub created_at_epoch_ms: u64,
}

impl TicketProposal {
    pub fn is_valid(&self) -> bool {
        valid_id(&self.id)
            && valid_id(&self.ticket_id)
            && valid_proposal_summary(&self.summary)
            && self.change.is_valid()
            && self.skill_id.as_deref().is_none_or(valid_id)
            && self.skill_id.is_some() == self.skill_version.is_some()
            && valid_evidence(&self.evidence)
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
