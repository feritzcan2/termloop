/// How a Project is presented and which work its Agents are oriented toward.
/// Every Project starts as `Developer`; that is also the meaning of a Project
/// with no stored setting.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectMode {
    #[default]
    Developer,
    ProjectManager,
}

/// The current mode of one Project. Only a Project switched away from the
/// default carries a record, so state written before modes existed reads as
/// all-`Developer` without migration of Project records.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectModeSetting {
    pub project_id: String,
    pub mode: ProjectMode,
}

impl ProjectModeSetting {
    pub fn is_valid(&self) -> bool {
        !self.project_id.trim().is_empty() && self.mode != ProjectMode::Developer
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn developer_is_the_default_and_never_stored() {
        assert_eq!(ProjectMode::default(), ProjectMode::Developer);
        assert!(
            !ProjectModeSetting {
                project_id: "project".into(),
                mode: ProjectMode::Developer,
            }
            .is_valid()
        );
        assert!(
            ProjectModeSetting {
                project_id: "project".into(),
                mode: ProjectMode::ProjectManager,
            }
            .is_valid()
        );
        assert!(
            !ProjectModeSetting {
                project_id: " ".into(),
                mode: ProjectMode::ProjectManager,
            }
            .is_valid()
        );
    }
}
