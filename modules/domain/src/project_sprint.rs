//! Local sprints and the delivery facts a Project Manager tracks per Task.
//!
//! Sprints belong to TermLoop, not to Jira: a Project Manager plans Tasks into
//! them, and only the Tasks of the one active sprint keep a Task Agent.

pub const SPRINT_NAME_MAX_CHARS: usize = 80;
pub const PROJECT_SPRINTS_MAX: usize = 64;
pub const TASK_TRACKING_TEXT_MAX_BYTES: usize = 4_000;
pub const TASK_TRACKING_SHORT_MAX_CHARS: usize = 120;
pub const TASK_ENVIRONMENTS_MAX: usize = 12;
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
}

impl ProjectSprint {
    pub fn is_valid(&self) -> bool {
        !self.id.trim().is_empty()
            && !self.project_id.trim().is_empty()
            && valid_sprint_name(&self.name)
    }
}

pub fn valid_sprint_name(name: &str) -> bool {
    !name.trim().is_empty() && name.trim() == name && name.chars().count() <= SPRINT_NAME_MAX_CHARS
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentDeployState {
    #[default]
    Unknown,
    NotDeployed,
    InProgress,
    Deployed,
}

/// Whether, and with what evidence, a Task's change reached one environment.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskEnvironmentStatus {
    pub name: String,
    pub state: EnvironmentDeployState,
    #[serde(default)]
    pub detail: Option<String>,
}

/// The Project Manager's record for one Task: its sprint and the delivery
/// facts the Task Agent fills in and the Project Manager corrects.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskTrackingRecord {
    pub task_id: String,
    #[serde(default)]
    pub sprint_id: Option<String>,
    #[serde(default)]
    pub developer: Option<String>,
    #[serde(default)]
    pub jira_status: Option<String>,
    #[serde(default)]
    pub environments: Vec<TaskEnvironmentStatus>,
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
            && valid_short(self.jira_status.as_deref())
            && valid_long(self.blockers.as_deref())
            && valid_long(self.note.as_deref())
            && self.environments.len() <= TASK_ENVIRONMENTS_MAX
            && self
                .environments
                .iter()
                .enumerate()
                .all(|(index, environment)| {
                    valid_short(Some(&environment.name))
                        && valid_short(environment.detail.as_deref())
                        && !self.environments[index + 1..]
                            .iter()
                            .any(|other| other.name.eq_ignore_ascii_case(&environment.name))
                })
    }

    /// A record with nothing in it is stored as its absence.
    pub fn is_empty(&self) -> bool {
        self.sprint_id.is_none()
            && self.developer.is_none()
            && self.jira_status.is_none()
            && self.environments.is_empty()
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

/// Everything a Project Manager ticket says: the Task's title and Markdown
/// description and its tracked delivery facts. The sprint is planning, not
/// ticket content, so it is not versioned.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskTicketContent {
    pub title: String,
    #[serde(default)]
    pub brief: Option<String>,
    #[serde(default)]
    pub developer: Option<String>,
    #[serde(default)]
    pub jira_status: Option<String>,
    #[serde(default)]
    pub environments: Vec<TaskEnvironmentStatus>,
    #[serde(default)]
    pub blockers: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

impl TaskTicketContent {
    pub fn is_valid(&self) -> bool {
        !self.title.trim().is_empty()
            && self.title.trim() == self.title
            && self.title.chars().count() <= TASK_TICKET_TITLE_MAX_CHARS
            && self.brief.as_deref().is_none_or(|brief| {
                !brief.trim().is_empty() && brief.chars().count() <= TASK_TICKET_BRIEF_MAX_CHARS
            })
            && TaskTrackingRecord {
                task_id: "ticket".into(),
                ..self.tracking(None, 0)
            }
            .is_valid()
    }

    /// The tracking record this content describes, in the given sprint.
    pub fn tracking(
        &self,
        sprint_id: Option<String>,
        updated_at_epoch_ms: u64,
    ) -> TaskTrackingRecord {
        TaskTrackingRecord {
            task_id: String::new(),
            sprint_id,
            developer: self.developer.clone(),
            jira_status: self.jira_status.clone(),
            environments: self.environments.clone(),
            blockers: self.blockers.clone(),
            note: self.note.clone(),
            updated_at_epoch_ms,
        }
    }
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
            && self.summary.as_deref().is_none_or(|summary| {
                !summary.trim().is_empty()
                    && summary.chars().count() <= TASK_TICKET_SUMMARY_MAX_CHARS
            })
            && self.content.is_valid()
    }
}

fn valid_short(value: Option<&str>) -> bool {
    value.is_none_or(|value| {
        !value.trim().is_empty()
            && value.trim() == value
            && value.chars().count() <= TASK_TRACKING_SHORT_MAX_CHARS
    })
}

fn valid_long(value: Option<&str>) -> bool {
    value
        .is_none_or(|value| !value.trim().is_empty() && value.len() <= TASK_TRACKING_TEXT_MAX_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> TaskTrackingRecord {
        TaskTrackingRecord {
            task_id: "task".into(),
            developer: Some("Ada".into()),
            environments: vec![TaskEnvironmentStatus {
                name: "Staging".into(),
                state: EnvironmentDeployState::Deployed,
                detail: Some("v1.4.2".into()),
            }],
            ..TaskTrackingRecord::default()
        }
    }

    #[test]
    fn tracking_records_hold_bounded_trimmed_facts_with_unique_environments() {
        assert!(record().is_valid());
        assert!(
            !TaskTrackingRecord {
                developer: Some(" Ada".into()),
                ..record()
            }
            .is_valid()
        );
        let mut duplicate = record();
        duplicate.environments.push(TaskEnvironmentStatus {
            name: "staging".into(),
            state: EnvironmentDeployState::Unknown,
            detail: None,
        });
        assert!(!duplicate.is_valid());
        assert!(
            TaskTrackingRecord {
                task_id: "task".into(),
                ..TaskTrackingRecord::default()
            }
            .is_empty()
        );
    }

    #[test]
    fn sprint_names_are_trimmed_and_bounded() {
        assert!(valid_sprint_name("Sprint 14"));
        assert!(!valid_sprint_name(" Sprint"));
        assert!(!valid_sprint_name(&"x".repeat(SPRINT_NAME_MAX_CHARS + 1)));
    }
}
