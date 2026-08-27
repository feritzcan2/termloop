//! Skill catalog command planning.
//!
//! The renderer selects only an opaque catalog identity. Core binds that
//! identity to an optional Project scope; the platform layer re-discovers the
//! source path immediately before any skills-manager mutation.

use std::path::{Path, PathBuf};

use crate::{CoreError, CoreRuntime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillDeploymentAgent {
    Claude,
    Codex,
}

impl SkillDeploymentAgent {
    pub fn manager_key(self) -> &'static str {
        match self {
            Self::Claude => "claude_code",
            Self::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillCatalogPlan {
    project_directory: Option<PathBuf>,
    project_name: Option<String>,
}

impl SkillCatalogPlan {
    pub fn project_directory(&self) -> Option<&Path> {
        self.project_directory.as_deref()
    }

    pub fn project_name(&self) -> Option<&str> {
        self.project_name.as_deref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDeploymentPlan {
    catalog: SkillCatalogPlan,
    skill_id: String,
    agent: SkillDeploymentAgent,
    deployed: bool,
}

impl SkillDeploymentPlan {
    pub fn catalog(&self) -> &SkillCatalogPlan {
        &self.catalog
    }

    pub fn skill_id(&self) -> &str {
        &self.skill_id
    }

    pub fn agent(&self) -> SkillDeploymentAgent {
        self.agent
    }

    pub fn deployed(&self) -> bool {
        self.deployed
    }
}

impl CoreRuntime {
    pub fn plan_skill_catalog(
        &self,
        project_id: Option<&str>,
    ) -> Result<SkillCatalogPlan, CoreError> {
        let Some(project_id) = project_id else {
            return Ok(SkillCatalogPlan {
                project_directory: None,
                project_name: None,
            });
        };
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .ok_or(CoreError::NotFound)?;
        Ok(SkillCatalogPlan {
            project_directory: Some(PathBuf::from(&project.folder_path)),
            project_name: Some(project.name.clone()),
        })
    }

    pub fn plan_skill_deployment(
        &self,
        project_id: Option<&str>,
        skill_id: &str,
        agent: SkillDeploymentAgent,
        deployed: bool,
    ) -> Result<SkillDeploymentPlan, CoreError> {
        if skill_id.len() != 64
            || !skill_id
                .bytes()
                .all(|value| value.is_ascii_digit() || matches!(value, b'a'..=b'f'))
        {
            return Err(CoreError::InvalidParams("skillId".into()));
        }
        Ok(SkillDeploymentPlan {
            catalog: self.plan_skill_catalog(project_id)?,
            skill_id: skill_id.to_owned(),
            agent,
            deployed,
        })
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
            "termloop-core-skills-{}-{}.json",
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
    fn catalog_plan_binds_only_a_known_project_without_writing_state() {
        let (mut runtime, state_path) = runtime();
        let project_directory =
            std::env::temp_dir().join(format!("skill-project-{}", Uuid::new_v4()));
        std::fs::create_dir(&project_directory).unwrap();
        let project = runtime
            .create_project(json!({ "name": "Skills", "folderPath": project_directory }))
            .unwrap();
        let revision = runtime.state_revision();

        let global = runtime.plan_skill_catalog(None).unwrap();
        assert!(global.project_directory().is_none());
        let scoped = runtime.plan_skill_catalog(project["id"].as_str()).unwrap();
        assert_eq!(scoped.project_name(), Some("Skills"));
        assert_eq!(
            scoped.project_directory(),
            Some(
                termloop_platform::canonical_existing_directory_path(&project_directory)
                    .unwrap()
                    .as_path()
            )
        );
        assert_eq!(runtime.state_revision(), revision);
        assert!(matches!(
            runtime.plan_skill_catalog(Some("missing")),
            Err(CoreError::NotFound)
        ));

        drop(runtime);
        let _ = std::fs::remove_file(state_path);
        let _ = std::fs::remove_dir(project_directory);
    }

    #[test]
    fn deployment_plan_rejects_non_opaque_renderer_identity() {
        let (runtime, state_path) = runtime();
        assert!(matches!(
            runtime.plan_skill_deployment(
                None,
                "/Users/example/.claude/skills/private",
                SkillDeploymentAgent::Codex,
                true,
            ),
            Err(CoreError::InvalidParams(field)) if field == "skillId"
        ));
        let plan = runtime
            .plan_skill_deployment(None, &"a".repeat(64), SkillDeploymentAgent::Claude, false)
            .unwrap();
        assert_eq!(plan.agent().manager_key(), "claude_code");
        assert!(!plan.deployed());
        let _ = std::fs::remove_file(state_path);
    }
}
