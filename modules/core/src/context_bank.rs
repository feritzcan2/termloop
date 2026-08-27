//! Context Bank read/write planning.
//!
//! The renderer supplies a Project and opaque file identity. Core binds both to
//! the current Project checkout; platform re-discovers and validates the file
//! immediately before reading or replacing its content.

use std::path::{Path, PathBuf};

use crate::{CoreError, CoreRuntime};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextBankCatalogPlan {
    project_directory: PathBuf,
    project_name: String,
}

impl ContextBankCatalogPlan {
    pub fn project_directory(&self) -> &Path {
        &self.project_directory
    }

    pub fn project_name(&self) -> &str {
        &self.project_name
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextBankFilePlan {
    catalog: ContextBankCatalogPlan,
    file_id: String,
}

impl ContextBankFilePlan {
    pub fn catalog(&self) -> &ContextBankCatalogPlan {
        &self.catalog
    }

    pub fn file_id(&self) -> &str {
        &self.file_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextBankSiblingConflictPlan {
    catalog: ContextBankCatalogPlan,
    conflict_id: String,
    source_file_id: String,
}

impl ContextBankSiblingConflictPlan {
    pub fn catalog(&self) -> &ContextBankCatalogPlan {
        &self.catalog
    }

    pub fn conflict_id(&self) -> &str {
        &self.conflict_id
    }

    pub fn source_file_id(&self) -> &str {
        &self.source_file_id
    }
}

impl CoreRuntime {
    pub fn plan_context_bank_catalog(
        &self,
        project_id: &str,
    ) -> Result<ContextBankCatalogPlan, CoreError> {
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .ok_or(CoreError::NotFound)?;
        Ok(ContextBankCatalogPlan {
            project_directory: PathBuf::from(&project.folder_path),
            project_name: project.name.clone(),
        })
    }

    pub fn plan_context_bank_file(
        &self,
        project_id: &str,
        file_id: &str,
    ) -> Result<ContextBankFilePlan, CoreError> {
        validate_opaque_sha256(file_id, "fileId")?;
        Ok(ContextBankFilePlan {
            catalog: self.plan_context_bank_catalog(project_id)?,
            file_id: file_id.to_owned(),
        })
    }

    pub fn plan_context_bank_sibling_conflict(
        &self,
        project_id: &str,
        conflict_id: &str,
        source_file_id: &str,
    ) -> Result<ContextBankSiblingConflictPlan, CoreError> {
        validate_opaque_sha256(conflict_id, "conflictId")?;
        validate_opaque_sha256(source_file_id, "sourceFileId")?;
        Ok(ContextBankSiblingConflictPlan {
            catalog: self.plan_context_bank_catalog(project_id)?,
            conflict_id: conflict_id.to_owned(),
            source_file_id: source_file_id.to_owned(),
        })
    }
}

fn validate_opaque_sha256(value: &str, field: &'static str) -> Result<(), CoreError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(CoreError::InvalidParams(field.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use termloop_store::Store;
    use termloop_terminal::TerminalService;
    use uuid::Uuid;

    fn runtime() -> (CoreRuntime, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-context-bank-{}-{}.json",
            std::process::id(),
            Uuid::new_v4()
        ));
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(&path).unwrap();
        (
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap(),
            path,
        )
    }

    #[test]
    fn catalog_plan_binds_a_known_project_without_writing_state() {
        let (mut runtime, state_path) = runtime();
        let project_directory =
            std::env::temp_dir().join(format!("context-bank-project-{}", Uuid::new_v4()));
        std::fs::create_dir(&project_directory).unwrap();
        let project = runtime
            .create_project(json!({ "name": "Context", "folderPath": project_directory }))
            .unwrap();
        let revision = runtime.state_revision();

        let plan = runtime
            .plan_context_bank_catalog(project["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(plan.project_name(), "Context");
        assert_eq!(
            plan.project_directory(),
            termloop_platform::canonical_existing_directory_path(&project_directory)
                .unwrap()
                .as_path()
        );
        assert_eq!(runtime.state_revision(), revision);
        assert!(matches!(
            runtime.plan_context_bank_catalog("missing"),
            Err(CoreError::NotFound)
        ));

        drop(runtime);
        let _ = std::fs::remove_file(state_path);
        let _ = std::fs::remove_dir(project_directory);
    }

    #[test]
    fn file_plan_accepts_only_an_opaque_identity() {
        let (mut runtime, state_path) = runtime();
        let project_directory =
            std::env::temp_dir().join(format!("context-bank-file-project-{}", Uuid::new_v4()));
        std::fs::create_dir(&project_directory).unwrap();
        let project = runtime
            .create_project(json!({ "name": "Context", "folderPath": project_directory }))
            .unwrap();
        let project_id = project["id"].as_str().unwrap();

        assert!(matches!(
            runtime.plan_context_bank_file(project_id, "/project/AGENTS.md"),
            Err(CoreError::InvalidParams(field)) if field == "fileId"
        ));
        let plan = runtime
            .plan_context_bank_file(project_id, &"a".repeat(64))
            .unwrap();
        assert_eq!(plan.file_id(), "a".repeat(64));

        let conflict = runtime
            .plan_context_bank_sibling_conflict(project_id, &"b".repeat(64), &"c".repeat(64))
            .unwrap();
        assert_eq!(conflict.conflict_id(), "b".repeat(64));
        assert_eq!(conflict.source_file_id(), "c".repeat(64));
        assert!(matches!(
            runtime.plan_context_bank_sibling_conflict(
                project_id,
                &"B".repeat(64),
                &"c".repeat(64),
            ),
            Err(CoreError::InvalidParams(field)) if field == "conflictId"
        ));

        drop(runtime);
        let _ = std::fs::remove_file(state_path);
        let _ = std::fs::remove_dir(project_directory);
    }
}
