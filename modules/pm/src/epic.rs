//! Epics: a larger goal of one project that its tickets work toward. An
//! epic's progress is derived from its tickets on read and never stored.
//! The assistant splits a goal into tickets through a breakdown, a proposal
//! that changes nothing until the PM accepts the tasks it keeps.

use crate::proposal::valid_proposal_summary;
use crate::ticket::{
    TICKET_CRITERIA_MAX, valid_ticket_description, valid_ticket_item, valid_ticket_title,
};
use crate::validation::{valid_id, valid_label};

pub const EPIC_TITLE_MAX_CHARS: usize = 160;
pub const EPIC_DESCRIPTION_MAX_CHARS: usize = 20_000;
/// Epics one project may hold.
pub const PROJECT_EPICS_MAX: usize = 256;
/// Tasks one breakdown may propose.
pub const BREAKDOWN_TASKS_MAX: usize = 30;
/// Breakdowns waiting for the PM in one project at once.
pub const PROJECT_BREAKDOWNS_MAX: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Epic {
    pub id: String,
    pub project_id: String,
    pub title: String,
    /// The goal in Markdown; may be empty.
    pub description: String,
    pub created_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
}

/// The epic fields edited together; `None` leaves a field unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EpicEdit {
    pub title: Option<String>,
    pub description: Option<String>,
}

/// A new epic a breakdown proposes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EpicDraft {
    pub title: String,
    #[serde(default)]
    pub description: String,
}

/// One ticket a breakdown proposes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BreakdownTask {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
}

/// An agent's split of a goal into tickets: for a new epic (`epic`) or an
/// existing one (`epic_id`), never both.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EpicBreakdown {
    pub id: String,
    pub project_id: String,
    pub epic_id: Option<String>,
    pub epic: Option<EpicDraft>,
    pub tasks: Vec<BreakdownTask>,
    /// One line on what the split rests on.
    pub summary: String,
    pub created_at_epoch_ms: u64,
}

/// The one assistant conversation a project resumes: which provider holds
/// it under which native session id, started in which folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantConversation {
    pub project_id: String,
    pub provider: String,
    pub conversation_id: String,
    pub cwd: String,
    pub started_at_epoch_ms: u64,
}

/// Bounds of a stored conversation's provider, session id, and folder.
const CONVERSATION_FIELD_MAX_CHARS: usize = 4_096;

impl AssistantConversation {
    pub fn is_valid(&self) -> bool {
        valid_id(&self.project_id)
            && [&self.provider, &self.conversation_id, &self.cwd]
                .iter()
                .all(|field| valid_label(field, CONVERSATION_FIELD_MAX_CHARS))
    }
}

pub fn valid_epic_title(title: &str) -> bool {
    valid_ticket_title(title) && title.chars().count() <= EPIC_TITLE_MAX_CHARS
}

pub fn valid_epic_description(description: &str) -> bool {
    valid_ticket_description(description)
        && description.chars().count() <= EPIC_DESCRIPTION_MAX_CHARS
}

impl EpicDraft {
    pub fn is_valid(&self) -> bool {
        valid_epic_title(&self.title) && valid_epic_description(&self.description)
    }
}

impl BreakdownTask {
    pub fn is_valid(&self) -> bool {
        let criteria = &self.acceptance_criteria;
        valid_ticket_title(&self.title)
            && valid_ticket_description(&self.description)
            && criteria.len() <= TICKET_CRITERIA_MAX
            && criteria.iter().enumerate().all(|(index, text)| {
                valid_ticket_item(text) && !criteria[index + 1..].contains(text)
            })
    }
}

impl EpicBreakdown {
    pub fn is_valid(&self) -> bool {
        valid_id(&self.id)
            && valid_id(&self.project_id)
            && valid_breakdown_target(self.epic_id.as_deref(), self.epic.as_ref())
            && valid_breakdown_tasks(&self.tasks)
            && valid_proposal_summary(&self.summary)
    }
}

/// Exactly one of an existing epic and a new one.
pub(crate) fn valid_breakdown_target(epic_id: Option<&str>, epic: Option<&EpicDraft>) -> bool {
    match (epic_id, epic) {
        (Some(id), None) => valid_id(id),
        (None, Some(draft)) => draft.is_valid(),
        _ => false,
    }
}

/// At least one task, bounded, each valid, with distinct titles.
pub(crate) fn valid_breakdown_tasks(tasks: &[BreakdownTask]) -> bool {
    !tasks.is_empty()
        && tasks.len() <= BREAKDOWN_TASKS_MAX
        && tasks.iter().enumerate().all(|(index, task)| {
            task.is_valid()
                && !tasks[index + 1..]
                    .iter()
                    .any(|other| other.title == task.title)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(title: &str) -> BreakdownTask {
        BreakdownTask {
            title: title.to_owned(),
            description: String::new(),
            acceptance_criteria: vec!["Works".to_owned()],
        }
    }

    #[test]
    fn a_breakdown_targets_exactly_one_epic() {
        let draft = EpicDraft {
            title: "Checkout".to_owned(),
            description: String::new(),
        };
        assert!(valid_breakdown_target(Some("e1"), None));
        assert!(valid_breakdown_target(None, Some(&draft)));
        assert!(!valid_breakdown_target(None, None));
        assert!(!valid_breakdown_target(Some("e1"), Some(&draft)));
    }

    #[test]
    fn breakdown_tasks_are_bounded_and_distinct() {
        assert!(valid_breakdown_tasks(&[task("API"), task("UI")]));
        assert!(!valid_breakdown_tasks(&[]));
        assert!(!valid_breakdown_tasks(&[task("API"), task("API")]));
        assert!(!valid_breakdown_tasks(&[task(" padded")]));
        let many: Vec<_> = (0..=BREAKDOWN_TASKS_MAX)
            .map(|index| task(&format!("Task {index}")))
            .collect();
        assert!(!valid_breakdown_tasks(&many));
        let mut repeated = task("API");
        repeated.acceptance_criteria = vec!["Same".to_owned(), "Same".to_owned()];
        assert!(!repeated.is_valid());
    }
}
