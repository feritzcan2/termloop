pub const TASK_SOURCE_NAME_MAX_BYTES: usize = 80;
pub const TASK_SOURCE_SITE_MAX_BYTES: usize = 2_048;
pub const TASK_SOURCE_JQL_MAX_BYTES: usize = 4_096;
pub const TASK_SOURCE_BOARD_NAME_MAX_BYTES: usize = 256;
pub const TASK_SOURCE_BOARDS_MAX: usize = 10;
pub const TASK_SOURCE_STATUSES_MAX: usize = 100;
pub const TASK_SOURCE_IGNORED_MAX: usize = 500;
pub const TASK_SOURCE_EXTERNAL_ID_MAX_BYTES: usize = 64;
pub const TASK_SOURCES_PER_PROJECT_MAX: usize = 16;
pub const TASK_SOURCE_REFRESH_MIN_SECONDS: u64 = 60;
pub const TASK_SOURCE_REFRESH_MAX_SECONDS: u64 = 86_400;
pub const TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT: u64 = 5;
pub const TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX: u64 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskSourceProvider {
    Jira,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskSourceScope {
    All,
    AssignedToMe,
    // Kept only so state written by the earlier single-board preview remains
    // readable. New commands store boards in `TaskSourceConfiguration::boards`
    // and use `All` for board-only sources.
    Board {
        board_id: String,
        board_name: String,
    },
    Jql {
        jql: String,
    },
}

impl TaskSourceScope {
    pub fn is_valid(&self) -> bool {
        match self {
            Self::All | Self::AssignedToMe => true,
            Self::Board {
                board_id,
                board_name,
            } => {
                valid_board_id(board_id)
                    && !board_name.trim().is_empty()
                    && board_name.len() <= TASK_SOURCE_BOARD_NAME_MAX_BYTES
                    && !board_name.bytes().any(|byte| byte.is_ascii_control())
            }
            Self::Jql { jql } => {
                !jql.trim().is_empty()
                    && jql.len() <= TASK_SOURCE_JQL_MAX_BYTES
                    && !jql.bytes().any(|byte| byte.is_ascii_control())
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskSourceBoardSelection {
    pub id: String,
    pub name: String,
}

impl TaskSourceBoardSelection {
    pub fn is_valid(&self) -> bool {
        valid_board_id(&self.id)
            && !self.name.trim().is_empty()
            && self.name.len() <= TASK_SOURCE_BOARD_NAME_MAX_BYTES
            && !self.name.bytes().any(|byte| byte.is_ascii_control())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskSourceStatusSelection {
    pub id: String,
    pub name: String,
}

impl TaskSourceStatusSelection {
    pub fn is_valid(&self) -> bool {
        valid_board_id(&self.id)
            && !self.name.trim().is_empty()
            && self.name.len() <= TASK_SOURCE_BOARD_NAME_MAX_BYTES
            && !self.name.bytes().any(|byte| byte.is_ascii_control())
    }
}

fn valid_board_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && value.as_bytes()[0] != b'0'
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskSourceImportPolicy {
    Review,
    AutoAdd,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskSourceConfiguration {
    pub id: String,
    pub project_id: String,
    pub provider: TaskSourceProvider,
    pub name: String,
    pub enabled: bool,
    pub generation: u64,
    pub site_base_url: String,
    pub scope: TaskSourceScope,
    #[serde(default)]
    pub boards: Vec<TaskSourceBoardSelection>,
    #[serde(default)]
    pub statuses: Vec<TaskSourceStatusSelection>,
    pub import_policy: TaskSourceImportPolicy,
    pub auto_import_active_task_limit: u64,
    pub refresh_interval_seconds: u64,
    #[serde(default)]
    pub ignored_external_ids: Vec<String>,
    pub created_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
}

impl TaskSourceConfiguration {
    pub fn is_valid(&self) -> bool {
        !self.id.trim().is_empty()
            && self.id.len() <= 64
            && !self.project_id.trim().is_empty()
            && !self.name.trim().is_empty()
            && self.name.len() <= TASK_SOURCE_NAME_MAX_BYTES
            && valid_site_base_url_shape(&self.site_base_url)
            && self.scope.is_valid()
            && self.boards.len() <= TASK_SOURCE_BOARDS_MAX
            && self.boards.iter().enumerate().all(|(index, board)| {
                board.is_valid()
                    && !self.boards[index + 1..]
                        .iter()
                        .any(|candidate| candidate.id == board.id)
            })
            && self.statuses.len() <= TASK_SOURCE_STATUSES_MAX
            && self.statuses.iter().enumerate().all(|(index, status)| {
                status.is_valid()
                    && !self.statuses[index + 1..]
                        .iter()
                        .any(|candidate| candidate.id == status.id)
            })
            && (self.statuses.is_empty() || !self.boards.is_empty())
            && (!matches!(self.scope, TaskSourceScope::Board { .. }) || self.boards.is_empty())
            && (1..=TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX)
                .contains(&self.auto_import_active_task_limit)
            && (TASK_SOURCE_REFRESH_MIN_SECONDS..=TASK_SOURCE_REFRESH_MAX_SECONDS)
                .contains(&self.refresh_interval_seconds)
            && self.generation > 0
            && self.created_at_epoch_ms > 0
            && self.updated_at_epoch_ms >= self.created_at_epoch_ms
            && self.ignored_external_ids.len() <= TASK_SOURCE_IGNORED_MAX
            && self
                .ignored_external_ids
                .iter()
                .enumerate()
                .all(|(index, value)| {
                    !value.trim().is_empty()
                        && value.len() <= TASK_SOURCE_EXTERNAL_ID_MAX_BYTES
                        && !value.bytes().any(|byte| byte.is_ascii_control())
                        && !self.ignored_external_ids[index + 1..].contains(value)
                })
    }
}

fn valid_site_base_url_shape(value: &str) -> bool {
    let Some(host) = value.strip_prefix("https://") else {
        return false;
    };
    host.len() > ".atlassian.net".len()
        && value.len() <= TASK_SOURCE_SITE_MAX_BYTES
        && host.ends_with(".atlassian.net")
        && !host.contains(['/', '?', '#', '@'])
        && host.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration() -> TaskSourceConfiguration {
        TaskSourceConfiguration {
            id: "source-1".into(),
            project_id: "project-1".into(),
            provider: TaskSourceProvider::Jira,
            name: "Assigned Jira work".into(),
            enabled: true,
            generation: 1,
            site_base_url: "https://example.atlassian.net".into(),
            scope: TaskSourceScope::AssignedToMe,
            boards: vec![],
            statuses: vec![],
            import_policy: TaskSourceImportPolicy::Review,
            auto_import_active_task_limit: TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT,
            refresh_interval_seconds: 900,
            ignored_external_ids: vec![],
            created_at_epoch_ms: 1,
            updated_at_epoch_ms: 1,
        }
    }

    #[test]
    fn validates_bounded_task_source_configuration() {
        assert!(configuration().is_valid());
        let mut invalid = configuration();
        invalid.scope = TaskSourceScope::Jql { jql: "  ".into() };
        assert!(!invalid.is_valid());
        let mut board = configuration();
        board.boards = vec![TaskSourceBoardSelection {
            id: "84".into(),
            name: "Payments".into(),
        }];
        assert!(board.is_valid());
        board.boards[0].id = "0".into();
        assert!(!board.is_valid());
        let mut duplicate = configuration();
        duplicate.boards = vec![
            TaskSourceBoardSelection {
                id: "84".into(),
                name: "Payments".into(),
            },
            TaskSourceBoardSelection {
                id: "84".into(),
                name: "Duplicate".into(),
            },
        ];
        assert!(!duplicate.is_valid());
        let mut statuses_without_board = configuration();
        statuses_without_board.statuses = vec![TaskSourceStatusSelection {
            id: "10000".into(),
            name: "In Progress".into(),
        }];
        assert!(!statuses_without_board.is_valid());
        statuses_without_board.boards = vec![TaskSourceBoardSelection {
            id: "84".into(),
            name: "Payments".into(),
        }];
        assert!(statuses_without_board.is_valid());
        let mut invalid = configuration();
        invalid.site_base_url = "https://user@example.atlassian.net".into();
        assert!(!invalid.is_valid());
        let mut invalid = configuration();
        invalid.site_base_url = "https://example.com".into();
        assert!(!invalid.is_valid());
        let mut invalid = configuration();
        invalid.site_base_url = "https://example.atlassian.net/path".into();
        assert!(!invalid.is_valid());
        let mut invalid = configuration();
        invalid.auto_import_active_task_limit = 0;
        assert!(!invalid.is_valid());
        let mut invalid = configuration();
        invalid.auto_import_active_task_limit = TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX + 1;
        assert!(!invalid.is_valid());
    }
}
