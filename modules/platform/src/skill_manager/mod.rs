//! Skills Manager orchestration and portable catalog projections.

mod cli;
mod discovery;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::{PlatformError, sibling_executable};

use cli::CliBackend;
#[cfg(test)]
use cli::{deployment_arguments, install_arguments, list_arguments};
use discovery::{discover_catalog, host_home_directory, read_text};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillAgent {
    Claude,
    Codex,
}

impl SkillAgent {
    fn from_manager_key(key: &str) -> Option<Self> {
        match key {
            "claude_code" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn manager_key(self) -> &'static str {
        match self {
            Self::Claude => "claude_code",
            Self::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillScope {
    User,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillOrigin {
    Shared,
    Personal,
    BuiltIn,
    Plugin,
    Managed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillAvailability {
    Folder,
    Configured,
    CacheSnapshot,
    ManagedLibrary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogLocation {
    pub path: String,
    pub scope: SkillScope,
    pub origin: SkillOrigin,
    pub agents: Vec<SkillAgent>,
    pub source: String,
    pub availability: SkillAvailability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAgentState {
    pub agent: SkillAgent,
    pub present: bool,
    pub managed: bool,
    pub target_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub agents: Vec<SkillAgent>,
    pub scopes: Vec<SkillScope>,
    pub origins: Vec<SkillOrigin>,
    pub locations: Vec<SkillCatalogLocation>,
    pub agent_states: Vec<SkillAgentState>,
    pub manageable: bool,
    #[serde(skip)]
    canonical_path: PathBuf,
    #[serde(skip)]
    manager_skill_id: Option<String>,
}

/// The user-editable `SKILL.md` behind one catalog entry, with a content hash
/// so saves can fail closed when the file changed on disk after the read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDefinition {
    pub skill_id: String,
    pub name: String,
    pub path: String,
    pub content: String,
    pub content_sha256: String,
    pub editable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalog {
    pub skills: Vec<SkillCatalogItem>,
    pub warnings: Vec<String>,
    pub project_included: bool,
    pub project_name: Option<String>,
    pub provider_snapshot_included: bool,
    pub manager_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillCatalogScope {
    project_directory: Option<PathBuf>,
    project_name: Option<String>,
}

impl SkillCatalogScope {
    pub fn global() -> Self {
        Self {
            project_directory: None,
            project_name: None,
        }
    }

    pub fn project(directory: impl Into<PathBuf>, name: impl Into<String>) -> Self {
        Self {
            project_directory: Some(directory.into()),
            project_name: Some(name.into()),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SkillManagerError {
    #[error("skills-manager is unavailable")]
    Unavailable,
    #[error("the selected skill is no longer available")]
    SkillNotFound,
    #[error("the selected skill cannot be managed")]
    SkillNotManageable,
    #[error("skills-manager returned unsupported output")]
    InvalidOutput,
    #[error("SKILL.md is missing or could not be read")]
    DefinitionUnreadable,
    #[error("SKILL.md changed on disk since it was read; reload before saving")]
    StaleDefinition,
    #[error("skills-manager command failed: {0}")]
    CommandFailed(String),
    #[error(transparent)]
    Platform(#[from] PlatformError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Deserialize)]
struct ManagerSkill {
    id: String,
    name: String,
    description: Option<String>,
    path: String,
    source_ref: Option<String>,
    #[serde(default)]
    deployed_to: Vec<String>,
}

trait ManagerBackend: Send + Sync {
    fn list(&self) -> Result<Vec<ManagerSkill>, SkillManagerError>;
    fn install_local(&self, path: &Path) -> Result<String, SkillManagerError>;
    fn set_deployment(
        &self,
        skill_id: &str,
        agent: SkillAgent,
        deployed: bool,
    ) -> Result<(), SkillManagerError>;
}

#[derive(Clone)]
pub struct SkillManager {
    backend: Option<Arc<dyn ManagerBackend>>,
}

impl std::fmt::Debug for SkillManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SkillManager")
            .field("available", &self.backend.is_some())
            .finish()
    }
}

impl SkillManager {
    pub fn discover() -> Self {
        let backend = sibling_executable("skills-manager-cli")
            .ok()
            .map(|executable| Arc::new(CliBackend::new(executable)) as Arc<dyn ManagerBackend>);
        Self { backend }
    }

    pub fn catalog(&self, scope: SkillCatalogScope) -> Result<SkillCatalog, SkillManagerError> {
        let home = host_home_directory().ok_or(SkillManagerError::Unavailable)?;
        self.catalog_at(&home, scope)
    }

    pub fn set_deployment(
        &self,
        scope: SkillCatalogScope,
        skill_id: &str,
        agent: SkillAgent,
        deployed: bool,
    ) -> Result<SkillCatalog, SkillManagerError> {
        let home = host_home_directory().ok_or(SkillManagerError::Unavailable)?;
        self.set_deployment_at(&home, scope, skill_id, agent, deployed)
    }

    fn set_deployment_at(
        &self,
        home: &Path,
        scope: SkillCatalogScope,
        skill_id: &str,
        agent: SkillAgent,
        deployed: bool,
    ) -> Result<SkillCatalog, SkillManagerError> {
        let backend = self
            .backend
            .as_ref()
            .ok_or(SkillManagerError::Unavailable)?;
        let mut catalog = discover_catalog(home, &scope, Some(backend.as_ref()), true)?;
        let skill = catalog
            .skills
            .iter()
            .find(|skill| skill.id == skill_id)
            .ok_or(SkillManagerError::SkillNotFound)?;
        if !skill.manageable {
            return Err(SkillManagerError::SkillNotManageable);
        }
        let current = skill
            .agent_states
            .iter()
            .find(|state| state.agent == agent)
            .is_some_and(|state| state.managed);
        if current == deployed {
            return Ok(catalog);
        }
        let manager_skill_id = match (&skill.manager_skill_id, deployed) {
            (Some(manager_skill_id), _) => manager_skill_id.clone(),
            (None, true) => backend.install_local(&skill.canonical_path)?,
            (None, false) => return Ok(catalog),
        };
        backend.set_deployment(&manager_skill_id, agent, deployed)?;
        catalog = discover_catalog(home, &scope, Some(backend.as_ref()), true)?;
        Ok(catalog)
    }

    fn catalog_at(
        &self,
        home: &Path,
        scope: SkillCatalogScope,
    ) -> Result<SkillCatalog, SkillManagerError> {
        discover_catalog(home, &scope, self.backend.as_deref(), false)
    }

    pub fn read_definition(
        &self,
        scope: SkillCatalogScope,
        skill_id: &str,
    ) -> Result<SkillDefinition, SkillManagerError> {
        let home = host_home_directory().ok_or(SkillManagerError::Unavailable)?;
        self.read_definition_at(&home, scope, skill_id)
    }

    fn read_definition_at(
        &self,
        home: &Path,
        scope: SkillCatalogScope,
        skill_id: &str,
    ) -> Result<SkillDefinition, SkillManagerError> {
        let catalog = self.catalog_at(home, scope)?;
        definition_of(locate_skill(&catalog, skill_id)?)
    }

    pub fn write_definition(
        &self,
        scope: SkillCatalogScope,
        skill_id: &str,
        expected_content_sha256: &str,
        content: &str,
    ) -> Result<SkillDefinition, SkillManagerError> {
        let home = host_home_directory().ok_or(SkillManagerError::Unavailable)?;
        self.write_definition_at(&home, scope, skill_id, expected_content_sha256, content)
    }

    fn write_definition_at(
        &self,
        home: &Path,
        scope: SkillCatalogScope,
        skill_id: &str,
        expected_content_sha256: &str,
        content: &str,
    ) -> Result<SkillDefinition, SkillManagerError> {
        let catalog = self.catalog_at(home, scope)?;
        let skill = locate_skill(&catalog, skill_id)?;
        if !skill.manageable {
            return Err(SkillManagerError::SkillNotManageable);
        }
        let current = definition_of(skill)?;
        if current.content_sha256 != expected_content_sha256 {
            return Err(SkillManagerError::StaleDefinition);
        }
        crate::atomic_replace_private_file(
            &skill.canonical_path.join("SKILL.md"),
            content.as_bytes(),
        )?;
        Ok(SkillDefinition {
            content: content.to_owned(),
            content_sha256: sha256_hex(content),
            ..current
        })
    }

    #[cfg(test)]
    fn with_backend(backend: Arc<dyn ManagerBackend>) -> Self {
        Self {
            backend: Some(backend),
        }
    }
}

fn locate_skill<'catalog>(
    catalog: &'catalog SkillCatalog,
    skill_id: &str,
) -> Result<&'catalog SkillCatalogItem, SkillManagerError> {
    catalog
        .skills
        .iter()
        .find(|skill| skill.id == skill_id)
        .ok_or(SkillManagerError::SkillNotFound)
}

fn definition_of(skill: &SkillCatalogItem) -> Result<SkillDefinition, SkillManagerError> {
    let path = skill.canonical_path.join("SKILL.md");
    let content = read_text(&path)?.ok_or(SkillManagerError::DefinitionUnreadable)?;
    Ok(SkillDefinition {
        skill_id: skill.id.clone(),
        name: skill.name.clone(),
        path: path.display().to_string(),
        content_sha256: sha256_hex(&content),
        content,
        editable: skill.manageable,
    })
}

fn sha256_hex(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    let mut value = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsString, fs, sync::Mutex};

    #[derive(Default)]
    struct FakeBackend {
        skills: Mutex<Vec<ManagerSkill>>,
        calls: Mutex<Vec<String>>,
    }

    impl ManagerBackend for FakeBackend {
        fn list(&self) -> Result<Vec<ManagerSkill>, SkillManagerError> {
            self.calls.lock().unwrap().push("list".into());
            Ok(self.skills.lock().unwrap().clone())
        }

        fn install_local(&self, path: &Path) -> Result<String, SkillManagerError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("install:{}", path.display()));
            let id = "manager-skill".to_owned();
            self.skills.lock().unwrap().push(ManagerSkill {
                id: id.clone(),
                name: "shared-review".into(),
                description: Some("Review changes.".into()),
                path: path.to_string_lossy().into_owned(),
                source_ref: Some(path.to_string_lossy().into_owned()),
                deployed_to: Vec::new(),
            });
            Ok(id)
        }

        fn set_deployment(
            &self,
            skill_id: &str,
            agent: SkillAgent,
            deployed: bool,
        ) -> Result<(), SkillManagerError> {
            self.calls.lock().unwrap().push(format!(
                "{}:{skill_id}:{}",
                if deployed { "deploy" } else { "undeploy" },
                agent.manager_key()
            ));
            if let Some(skill) = self
                .skills
                .lock()
                .unwrap()
                .iter_mut()
                .find(|skill| skill.id == skill_id)
            {
                if deployed {
                    skill.deployed_to.push(agent.manager_key().into());
                } else {
                    skill
                        .deployed_to
                        .retain(|current| current != agent.manager_key());
                }
            }
            Ok(())
        }
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "termloop-platform-{label}-{}-{}",
            std::process::id(),
            crate::generate_uuid_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_skill(directory: &Path, name: &str, description: &str) {
        fs::create_dir_all(directory).unwrap();
        fs::write(
            directory.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: >-\n  {description}\n---\n"),
        )
        .unwrap();
    }

    #[test]
    fn definition_read_and_stale_guarded_save_round_trip() {
        let root = temporary_directory("skills-definition");
        let home = root.join("home");
        let directory = home.join(".agents/skills/shared-review");
        write_skill(&directory, "shared-review", "Review changes.");
        let manager = SkillManager { backend: None };
        let scope = SkillCatalogScope::global();
        let catalog = manager.catalog_at(&home, scope.clone()).unwrap();
        let skill_id = catalog.skills[0].id.clone();

        let definition = manager
            .read_definition_at(&home, scope.clone(), &skill_id)
            .unwrap();
        assert!(definition.content.contains("shared-review"));
        assert_eq!(definition.content_sha256.len(), 64);
        assert!(definition.editable);
        assert!(definition.path.ends_with("SKILL.md"));

        assert!(matches!(
            manager.write_definition_at(&home, scope.clone(), &skill_id, &"f".repeat(64), "x"),
            Err(SkillManagerError::StaleDefinition)
        ));
        assert!(matches!(
            manager.read_definition_at(&home, scope.clone(), &"9".repeat(64)),
            Err(SkillManagerError::SkillNotFound)
        ));

        let updated = "---\nname: shared-review\ndescription: >-\n  Updated.\n---\nBody.\n";
        let saved = manager
            .write_definition_at(
                &home,
                scope.clone(),
                &skill_id,
                &definition.content_sha256,
                updated,
            )
            .unwrap();
        assert_eq!(saved.content, updated);
        assert_eq!(
            fs::read_to_string(directory.join("SKILL.md")).unwrap(),
            updated
        );
        assert_eq!(
            manager
                .read_definition_at(&home, scope, &skill_id)
                .unwrap()
                .content_sha256,
            saved.content_sha256
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovery_combines_user_project_and_provider_sources_with_opaque_ids() {
        let root = temporary_directory("skills-discovery");
        let home = root.join("home");
        let project = root.join("project");
        write_skill(
            &home.join(".agents/skills/shared-review"),
            "shared-review",
            "Review changes.",
        );
        write_skill(
            &project.join(".codex/skills/release"),
            "release",
            "Ship safely.",
        );
        let plugin = home.join(".codex/plugins/cache/market/plugin/1.0.0/skills/plugin-skill");
        write_skill(&plugin, "plugin-skill", "Plugin guidance.");

        let manager = SkillManager { backend: None };
        let result = manager
            .catalog_at(&home, SkillCatalogScope::project(&project, "TermLoop"))
            .unwrap();

        assert_eq!(result.skills.len(), 3);
        assert!(result.skills.iter().all(|skill| {
            skill.id.len() == 64 && skill.id.bytes().all(|value| value.is_ascii_hexdigit())
        }));
        assert_eq!(
            result
                .skills
                .iter()
                .find(|skill| skill.name == "shared-review")
                .unwrap()
                .agents,
            vec![SkillAgent::Claude, SkillAgent::Codex]
        );
        assert!(result.provider_snapshot_included);
        assert!(!result.manager_available);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deployment_re_resolves_opaque_id_then_installs_and_deploys() {
        let root = temporary_directory("skills-deployment");
        let home = root.join("home");
        write_skill(
            &home.join(".claude/skills/shared-review"),
            "shared-review",
            "Review changes.",
        );
        let backend = Arc::new(FakeBackend::default());
        let manager = SkillManager::with_backend(backend.clone());
        let catalog = manager
            .catalog_at(&home, SkillCatalogScope::global())
            .unwrap();
        let skill_id = catalog.skills[0].id.clone();

        let result = manager
            .set_deployment_at(
                &home,
                SkillCatalogScope::global(),
                &skill_id,
                SkillAgent::Codex,
                true,
            )
            .unwrap();

        assert!(
            result.skills[0]
                .agent_states
                .iter()
                .any(|state| state.agent == SkillAgent::Codex && state.managed)
        );
        assert!(
            backend
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call.ends_with(":codex"))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_unreadable_bundle_is_named_with_the_reason_the_os_gave() {
        let root = temporary_directory("skills-unreadable");
        let home = root.join("home");
        write_skill(&home.join(".codex/skills/healthy"), "healthy", "Fine.");
        // A SKILL.md that is not a regular file stands in for the bundles a
        // user cannot read — an evicted cloud file, a bad mount, a lost
        // permission — all of which reach the catalog as an OS error.
        fs::create_dir_all(home.join(".codex/skills/broken/SKILL.md")).unwrap();

        let result = SkillManager { backend: None }
            .catalog_at(&home, SkillCatalogScope::global())
            .unwrap();
        assert_eq!(result.skills.len(), 1);
        let warning = result
            .warnings
            .iter()
            .find(|warning| warning.contains("could not be read"))
            .expect("the unreadable bundle is reported");
        assert!(warning.starts_with("1 skill bundle could not be read: broken ("));
        assert!(!warning.contains("limit"));
    }

    #[test]
    fn a_large_definition_is_still_catalogued_and_built_ins_are_not_manageable() {
        let root = temporary_directory("skills-bounds");
        let home = root.join("home");
        let built_in = home.join(".codex/skills/.system/internal");
        write_skill(&built_in, "internal", "Provider-owned.");
        let large = home.join(".codex/skills/large");
        fs::create_dir_all(&large).unwrap();
        let body = format!(
            "---\nname: large\ndescription: A long one.\n---\n{}",
            "x".repeat(512 * 1024)
        );
        fs::write(large.join("SKILL.md"), body).unwrap();

        let result = SkillManager { backend: None }
            .catalog_at(&home, SkillCatalogScope::global())
            .unwrap();
        // The user's own file is never dropped for its size, so both bundles
        // are present and nothing is reported as unreadable.
        assert_eq!(result.skills.len(), 2);
        assert!(result.skills.iter().any(|skill| skill.name == "large"));
        assert!(
            result
                .warnings
                .iter()
                .all(|warning| !warning.contains("could not be read"))
        );
        assert!(
            result
                .skills
                .iter()
                .any(|skill| skill.name == "internal" && !skill.manageable)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cli_arguments_match_the_pinned_skills_manager_interface() {
        assert_eq!(
            list_arguments(),
            ["--json", "skills", "list"].map(OsString::from)
        );
        let source = Path::new("skill source");
        assert_eq!(
            install_arguments(source),
            vec![
                OsString::from("--json"),
                OsString::from("skills"),
                OsString::from("install"),
                source.as_os_str().to_owned(),
                OsString::from("--local"),
            ]
        );
        assert_eq!(
            deployment_arguments("skill-id", SkillAgent::Claude, true),
            [
                "--json",
                "skills",
                "deploy",
                "skill-id",
                "--agent",
                "claude_code",
            ]
            .map(OsString::from)
        );
        assert_eq!(
            deployment_arguments("skill-id", SkillAgent::Codex, false),
            [
                "--json", "skills", "undeploy", "skill-id", "--agent", "codex"
            ]
            .map(OsString::from)
        );
    }
}
