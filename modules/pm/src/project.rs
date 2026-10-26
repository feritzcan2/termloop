//! The projects registry: which PM projects exist, under which name, and
//! which local folder (if any) their agents work in.

use crate::validation::{valid_id, valid_label};

pub const PROJECT_NAME_MAX_CHARS: usize = 120;
pub const PROJECT_FOLDER_MAX_CHARS: usize = 4096;
/// The most projects one PM store holds.
pub const PROJECTS_MAX: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// The local folder agents of the project run in: its code repository.
    #[serde(default)]
    pub folder: Option<String>,
    pub created_at_epoch_ms: u64,
}

pub fn valid_project_name(name: &str) -> bool {
    valid_label(name, PROJECT_NAME_MAX_CHARS)
}

/// An absolute, single-line, bounded folder path. Whether it exists is the
/// daemon's concern, not the store's.
pub fn valid_project_folder(folder: &str) -> bool {
    !folder.is_empty()
        && folder.chars().count() <= PROJECT_FOLDER_MAX_CHARS
        && !folder.chars().any(char::is_control)
        && std::path::Path::new(folder).is_absolute()
}

impl Project {
    pub fn is_valid(&self) -> bool {
        valid_id(&self.id)
            && valid_project_name(&self.name)
            && self.folder.as_deref().is_none_or(valid_project_folder)
    }
}
