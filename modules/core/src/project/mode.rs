//! The current mode each Project is opened in.

use serde_json::{Value, json};
use termloop_domain::ProjectMode;

use crate::{CoreError, CoreRuntime, required_string, store_error};

impl CoreRuntime {
    /// Whether the experimental Project Manager mode is switched on for this
    /// daemon. While it is off every Project is a `Developer` Project, whatever
    /// mode it has stored.
    pub fn project_manager_mode_enabled(&self) -> bool {
        self.store.project_manager_mode_enabled()
    }

    /// A Project without a stored setting is a `Developer` Project, and so is
    /// every Project while the Project Manager mode switch is off.
    pub fn project_mode(&self, project_id: &str) -> Result<ProjectMode, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        if !self.project_manager_mode_enabled() {
            return Ok(ProjectMode::Developer);
        }
        Ok(self
            .store
            .project_mode_settings()
            .iter()
            .find(|setting| setting.project_id == project_id)
            .map_or(ProjectMode::Developer, |setting| setting.mode))
    }

    /// The mode an Agent launch in this Project runs under. A Project that is
    /// gone by the time the launch is planned is treated as a Developer one;
    /// the launch's own Project checks refuse it.
    pub(crate) fn project_mode_or_developer(&self, project_id: &str) -> ProjectMode {
        self.project_mode(project_id).unwrap_or_default()
    }

    /// Whether this Project is opened as Project Manager. A missing Project is
    /// not one.
    pub fn is_project_manager_project(&self, project_id: &str) -> bool {
        self.project_mode_or_developer(project_id) == ProjectMode::ProjectManager
    }

    pub(crate) fn get_project_mode(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let mode = self.project_mode(&project_id)?;
        Ok(self.project_mode_result(&project_id, mode))
    }

    pub(crate) fn set_project_mode(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let mode = params
            .get("mode")
            .cloned()
            .and_then(|value| serde_json::from_value::<ProjectMode>(value).ok())
            .ok_or_else(|| CoreError::InvalidParams("mode".into()))?;
        let expected_revision = params
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::InvalidParams("expectedRevision".into()))?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        if mode != ProjectMode::Developer && !self.project_manager_mode_enabled() {
            return Err(CoreError::CapabilityDenied);
        }
        self.store
            .set_project_mode(&self.write_authority, &project_id, mode, expected_revision)
            .map_err(store_error)?;
        Ok(self.project_mode_result(&project_id, mode))
    }

    pub(crate) fn get_project_manager_mode(&self) -> Value {
        json!({
            "enabled": self.project_manager_mode_enabled(),
            "stateRevision": self.store.revision(),
        })
    }

    pub(crate) fn set_project_manager_mode(&mut self, params: Value) -> Result<Value, CoreError> {
        let enabled = params
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| CoreError::InvalidParams("enabled".into()))?;
        self.store
            .set_project_manager_mode_enabled(&self.write_authority, enabled)
            .map_err(store_error)?;
        Ok(self.get_project_manager_mode())
    }

    fn project_mode_result(&self, project_id: &str, mode: ProjectMode) -> Value {
        json!({
            "projectId": project_id,
            "mode": mode,
            "stateRevision": self.store.revision(),
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use termloop_store::Store;
    use termloop_terminal::TerminalService;
    use uuid::Uuid;

    use crate::{CoreError, CoreRuntime};

    fn runtime_with_project() -> (CoreRuntime, String, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-project-mode-{}-{}.json",
            std::process::id(),
            Uuid::new_v4()
        ));
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let mut runtime = CoreRuntime::new(
            Store::open(&path).unwrap(),
            authority,
            TerminalService::default(),
            1,
        )
        .unwrap();
        let project = runtime
            .handle(
                "project.create",
                json!({ "name": "Payments", "folderPath": std::env::temp_dir() }),
            )
            .unwrap();
        runtime
            .handle("projectManager.modeSet", json!({ "enabled": true }))
            .unwrap();
        (runtime, project["id"].as_str().unwrap().to_owned(), path)
    }

    #[test]
    fn a_new_project_is_a_developer_project() {
        let (mut runtime, project_id, path) = runtime_with_project();
        let result = runtime
            .handle("project.modeGet", json!({ "projectId": project_id }))
            .unwrap();
        assert_eq!(result["mode"], "developer");
        assert_eq!(result["projectId"], project_id.as_str());
        assert!(matches!(
            runtime.handle("project.modeGet", json!({ "projectId": "missing" })),
            Err(CoreError::NotFound)
        ));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn switching_mode_is_revision_checked_and_survives_reopen() {
        let (mut runtime, project_id, path) = runtime_with_project();
        let revision = runtime.state_revision();
        let switched = runtime
            .handle(
                "project.modeSet",
                json!({ "projectId": project_id, "mode": "projectManager", "expectedRevision": revision }),
            )
            .unwrap();
        assert_eq!(switched["mode"], "projectManager");
        assert!(switched["stateRevision"].as_u64().unwrap() > revision);
        assert!(matches!(
            runtime.handle(
                "project.modeSet",
                json!({ "projectId": project_id, "mode": "developer", "expectedRevision": revision }),
            ),
            Err(CoreError::RevisionConflict)
        ));
        drop(runtime);
        let mut reopened = CoreRuntime::open(&path, TerminalService::default(), 2).unwrap();
        assert_eq!(
            reopened
                .handle("project.modeGet", json!({ "projectId": project_id }))
                .unwrap()["mode"],
            "projectManager"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unknown_modes_and_missing_revisions_are_refused_without_a_write() {
        let (mut runtime, project_id, path) = runtime_with_project();
        let revision = runtime.state_revision();
        assert!(matches!(
            runtime.handle(
                "project.modeSet",
                json!({ "projectId": project_id, "mode": "manager", "expectedRevision": revision }),
            ),
            Err(CoreError::InvalidParams(field)) if field == "mode"
        ));
        assert!(matches!(
            runtime.handle(
                "project.modeSet",
                json!({ "projectId": project_id, "mode": "projectManager" }),
            ),
            Err(CoreError::InvalidParams(field)) if field == "expectedRevision"
        ));
        assert!(matches!(
            runtime.handle(
                "project.modeSet",
                json!({ "projectId": "missing", "mode": "projectManager", "expectedRevision": revision }),
            ),
            Err(CoreError::NotFound)
        ));
        assert_eq!(runtime.state_revision(), revision);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_mode_switch_gates_every_stored_project_mode() {
        let (mut runtime, project_id, path) = runtime_with_project();
        let revision = runtime.state_revision();
        runtime
            .handle(
                "project.modeSet",
                json!({ "projectId": project_id, "mode": "projectManager", "expectedRevision": revision }),
            )
            .unwrap();
        let off = runtime
            .handle("projectManager.modeSet", json!({ "enabled": false }))
            .unwrap();
        assert_eq!(off["enabled"], false);
        assert!(!runtime.is_project_manager_project(&project_id));
        assert_eq!(
            runtime
                .handle("project.modeGet", json!({ "projectId": project_id }))
                .unwrap()["mode"],
            "developer"
        );
        let revision = runtime.state_revision();
        assert!(matches!(
            runtime.handle(
                "project.modeSet",
                json!({ "projectId": project_id, "mode": "projectManager", "expectedRevision": revision }),
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.handle("projectManager.modeSet", json!({ "enabled": "yes" })),
            Err(CoreError::InvalidParams(field)) if field == "enabled"
        ));
        // Switching back on restores the stored mode without another write.
        runtime
            .handle("projectManager.modeSet", json!({ "enabled": true }))
            .unwrap();
        assert!(runtime.is_project_manager_project(&project_id));
        assert_eq!(
            runtime.handle("projectManager.modeGet", json!({})).unwrap()["enabled"],
            true
        );
        let _ = std::fs::remove_file(path);
    }
}
