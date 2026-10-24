//! Sprints, the Project Manager's own statements about a Task, and its
//! versioned ticket.
//!
//! Everything here is written by the Project Manager. What TermLoop observes
//! about a Task lives in `project_delivery`; an Agent can only propose a
//! ticket change.

pub const SPRINT_NAME_MAX_CHARS: usize = 80;
pub const PROJECT_SPRINTS_MAX: usize = 64;
pub const TASK_TRACKING_TEXT_MAX_BYTES: usize = 4_000;
pub const TASK_TRACKING_SHORT_MAX_CHARS: usize = 120;
pub const TASK_TICKET_VERSIONS_MAX: usize = 50;
pub const TASK_TICKET_TITLE_MAX_CHARS: usize = 160;
pub const TASK_TICKET_BRIEF_MAX_CHARS: usize = 8_000;
pub const TASK_TICKET_SUMMARY_MAX_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SprintState {
    #[default]
    Planned,
    Active,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectSprint {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub state: SprintState,
    pub created_at_epoch_ms: u64,
    /// The Jira sprint this one mirrors. A mirrored sprint follows Jira and
    /// is never edited locally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jira: Option<JiraSprintMirror>,
}

impl ProjectSprint {
    pub fn is_valid(&self) -> bool {
        !self.id.trim().is_empty()
            && !self.project_id.trim().is_empty()
            && valid_sprint_name(&self.name)
            && self.jira.as_ref().is_none_or(JiraSprintMirror::is_valid)
    }
}

/// Which Jira sprint a mirrored sprint follows, and its planned dates.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JiraSprintMirror {
    pub sprint_id: u64,
    pub board_id: u64,
    #[serde(default)]
    pub start_epoch_ms: Option<u64>,
    #[serde(default)]
    pub end_epoch_ms: Option<u64>,
}

impl JiraSprintMirror {
    pub fn is_valid(&self) -> bool {
        self.sprint_id > 0 && self.board_id > 0
    }
}

pub fn valid_sprint_name(name: &str) -> bool {
    !name.trim().is_empty() && name.trim() == name && name.chars().count() <= SPRINT_NAME_MAX_CHARS
}

/// The Project Manager's own record for one Task: its sprint and what the
/// Project Manager states about it. Facts TermLoop observes live in
/// [`crate::TaskDeliveryFacts`]; nothing here is written by an Agent.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskTrackingRecord {
    pub task_id: String,
    #[serde(default)]
    pub sprint_id: Option<String>,
    /// Who works on the Task when the Project Manager knows better than Jira.
    #[serde(default)]
    pub developer: Option<String>,
    #[serde(default)]
    pub blockers: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    pub updated_at_epoch_ms: u64,
}

impl TaskTrackingRecord {
    pub fn is_valid(&self) -> bool {
        !self.task_id.trim().is_empty()
            && self
                .sprint_id
                .as_deref()
                .is_none_or(|id| !id.trim().is_empty())
            && valid_short(self.developer.as_deref())
            && valid_long(self.blockers.as_deref())
            && valid_long(self.note.as_deref())
    }

    /// A record with nothing in it is stored as its absence.
    pub fn is_empty(&self) -> bool {
        self.sprint_id.is_none()
            && self.developer.is_none()
            && self.blockers.is_none()
            && self.note.is_none()
    }
}

/// Who saved one version of a Task's ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TicketAuthor {
    ProjectManager,
    Agent,
}

/// What a Project Manager ticket says: the Task's title and Markdown
/// description. The Project Manager owns it; an Agent can only propose a
/// change ([`TaskTicketProposal`]) for the Project Manager to accept.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskTicketContent {
    pub title: String,
    #[serde(default)]
    pub brief: Option<String>,
}

impl TaskTicketContent {
    pub fn is_valid(&self) -> bool {
        valid_ticket_title(&self.title) && valid_ticket_brief(self.brief.as_deref())
    }
}

fn valid_ticket_title(title: &str) -> bool {
    !title.trim().is_empty()
        && title.trim() == title
        && title.chars().count() <= TASK_TICKET_TITLE_MAX_CHARS
}

fn valid_ticket_brief(brief: Option<&str>) -> bool {
    brief.is_none_or(|brief| {
        !brief.trim().is_empty() && brief.chars().count() <= TASK_TICKET_BRIEF_MAX_CHARS
    })
}

fn valid_ticket_summary(summary: Option<&str>) -> bool {
    summary.is_none_or(|summary| {
        !summary.trim().is_empty() && summary.chars().count() <= TASK_TICKET_SUMMARY_MAX_CHARS
    })
}

/// One saved state of a Task's ticket. Versions are numbered from 1 per Task
/// and only the newest `TASK_TICKET_VERSIONS_MAX` are kept.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskTicketVersion {
    pub task_id: String,
    pub number: u64,
    pub author: TicketAuthor,
    #[serde(default)]
    pub summary: Option<String>,
    pub content: TaskTicketContent,
    pub created_at_epoch_ms: u64,
}

impl TaskTicketVersion {
    pub fn is_valid(&self) -> bool {
        !self.task_id.trim().is_empty()
            && self.number > 0
            && valid_ticket_summary(self.summary.as_deref())
            && self.content.is_valid()
    }
}

/// An Agent's suggested change to a Task's ticket, waiting for the Project
/// Manager. A Task has at most one; a newer proposal replaces it. Accepting
/// it saves a ticket version, dismissing it removes it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskTicketProposal {
    pub task_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub brief: Option<String>,
    pub summary: String,
    /// The ticket version the proposal was written against; 0 for none.
    pub base_version: u64,
    pub proposed_at_epoch_ms: u64,
}

impl TaskTicketProposal {
    pub fn is_valid(&self) -> bool {
        !self.task_id.trim().is_empty()
            && (self.title.is_some() || self.brief.is_some())
            && self.title.as_deref().is_none_or(valid_ticket_title)
            && valid_ticket_brief(self.brief.as_deref())
            && valid_ticket_summary(Some(&self.summary))
    }
}

pub(crate) fn valid_short(value: Option<&str>) -> bool {
    value.is_none_or(|value| {
        !value.trim().is_empty()
            && value.trim() == value
            && value.chars().count() <= TASK_TRACKING_SHORT_MAX_CHARS
    })
}

pub(crate) fn valid_long(value: Option<&str>) -> bool {
    value
        .is_none_or(|value| !value.trim().is_empty() && value.len() <= TASK_TRACKING_TEXT_MAX_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracking_records_hold_bounded_trimmed_project_manager_statements() {
        let record = TaskTrackingRecord {
            task_id: "task".into(),
            developer: Some("Ada".into()),
            note: Some("Ask QA first".into()),
            ..TaskTrackingRecord::default()
        };
        assert!(record.is_valid());
        assert!(
            !TaskTrackingRecord {
                developer: Some(" Ada".into()),
                ..record.clone()
            }
            .is_valid()
        );
        assert!(
            TaskTrackingRecord {
                task_id: "task".into(),
                ..TaskTrackingRecord::default()
            }
            .is_empty()
        );
    }

    #[test]
    fn a_proposal_changes_something_within_the_ticket_bounds() {
        let proposal = TaskTicketProposal {
            task_id: "task".into(),
            title: None,
            brief: Some("## Status\n- Merged".into()),
            summary: "PR #42 merged".into(),
            base_version: 3,
            proposed_at_epoch_ms: 1,
        };
        assert!(proposal.is_valid());
        assert!(
            !TaskTicketProposal {
                brief: None,
                ..proposal.clone()
            }
            .is_valid()
        );
        assert!(
            !TaskTicketProposal {
                title: Some(" padded".into()),
                ..proposal.clone()
            }
            .is_valid()
        );
        assert!(
            !TaskTicketProposal {
                summary: "x".repeat(TASK_TICKET_SUMMARY_MAX_CHARS + 1),
                ..proposal
            }
            .is_valid()
        );
    }

    #[test]
    fn sprint_names_are_trimmed_and_bounded() {
        assert!(valid_sprint_name("Sprint 14"));
        assert!(!valid_sprint_name(" Sprint"));
        assert!(!valid_sprint_name(&"x".repeat(SPRINT_NAME_MAX_CHARS + 1)));
    }
}
