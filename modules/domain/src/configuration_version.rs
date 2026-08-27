use crate::ImproverSessionTarget;

pub const CONFIGURATION_VERSION_CONTENT_MAX_BYTES: usize = 512 * 1024;
pub const CONFIGURATION_VERSION_SUMMARY_MAX_BYTES: usize = 2 * 1024;
pub const CONFIGURATION_VERSIONS_PER_TARGET_MAX: usize = 24;

/// One accepted immutable configuration snapshot. Versions are bounded product
/// state for user-editable configuration, not an event log: each row contains
/// the complete value that was active at that version.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationVersion {
    pub id: String,
    pub project_id: String,
    pub target: ImproverSessionTarget,
    pub sequence: u64,
    pub content: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    pub created_at_epoch_ms: u64,
}

/// The currently applied snapshot for one versioned configuration target.
/// Selecting an existing immutable version moves this pointer; it does not
/// manufacture another snapshot.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationVersionSelection {
    pub project_id: String,
    pub target: ImproverSessionTarget,
    pub version_id: String,
}

impl ConfigurationVersionSelection {
    pub fn is_well_formed(&self) -> bool {
        !self.project_id.trim().is_empty()
            && self.target.is_well_formed()
            && bounded_id(&self.version_id)
    }
}

impl ConfigurationVersion {
    pub fn is_well_formed(&self) -> bool {
        bounded_id(&self.id)
            && !self.project_id.trim().is_empty()
            && self.target.is_well_formed()
            && self.sequence > 0
            && !self.content.is_empty()
            && self.content.len() <= CONFIGURATION_VERSION_CONTENT_MAX_BYTES
            && self.summary.len() <= CONFIGURATION_VERSION_SUMMARY_MAX_BYTES
            && self.source_session_id.as_deref().is_none_or(bounded_id)
            && self.created_at_epoch_ms > 0
    }
}

fn bounded_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ImproverSessionTargetKind;

    fn target() -> ImproverSessionTarget {
        ImproverSessionTarget {
            target_kind: ImproverSessionTargetKind::RoutineInstructions,
            target_id: Some("routine-1".into()),
        }
    }

    #[test]
    fn version_requires_complete_bounded_content() {
        let mut version = ConfigurationVersion {
            id: "version-1".into(),
            project_id: "project-1".into(),
            target: target(),
            sequence: 1,
            content: "{}".into(),
            summary: "Initial version".into(),
            source_session_id: None,
            created_at_epoch_ms: 1,
        };
        assert!(version.is_well_formed());
        version.content.clear();
        assert!(!version.is_well_formed());
    }
}
