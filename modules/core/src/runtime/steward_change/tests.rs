use serde_json::json;
use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};
use termloop_store::{Store, issue_core_write_authority_for_composition};
use termloop_terminal::TerminalService;

use crate::{AssistantAvailability, CoreError, CoreRuntime, StewardConfigurationUpdate};

struct Fixture {
    core: CoreRuntime,
    root: std::path::PathBuf,
    project: String,
}

impl Fixture {
    fn restore_plan(&self) -> crate::ConfigurationApplicationPlan {
        let target = termloop_domain::ImproverSessionTarget {
            target_kind: termloop_domain::ImproverSessionTargetKind::StewardInstructions,
            target_id: None,
        };
        let active = self
            .core
            .store
            .active_configuration_version(&self.project, &target)
            .unwrap();
        self.core
            .prepare_configuration_version_restore(json!({
                "projectId": self.project,
                "versionId": active.id,
                "expectedActiveVersionId": active.id,
            }))
            .unwrap()
    }

    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("termloop-steward-change-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut core = CoreRuntime::new(
            Store::open(root.join("state.json")).unwrap(),
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            1,
        )
        .unwrap();
        let project = core
            .handle(
                "project.create",
                json!({"name": "Steward change", "folderPath": root}),
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut fixture = Self {
            core,
            root,
            project,
        };
        fixture
            .change(
                "original",
                true,
                fixture.core.state_revision(),
                AssistantAvailability::Proven,
            )
            .unwrap();
        fixture
            .core
            .store
            .attach_steward_executor_session(
                &fixture.core.write_authority,
                SessionRecord {
                    id: "executor".into(),
                    project_id: fixture.project.clone(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: fixture.root.to_string_lossy().into_owned(),
                        agent_id: Some("codex".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    launch_selection: Default::default(),
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
                &fixture.project,
                1,
                1,
            )
            .unwrap();
        fixture
    }

    fn change(
        &mut self,
        prompt: &str,
        enabled: bool,
        revision: u64,
        capability: AssistantAvailability,
    ) -> Result<crate::StewardConfigurationCommit, CoreError> {
        self.core
            .set_steward_configuration(StewardConfigurationUpdate {
                project_id: &self.project,
                agent_id: "codex",
                model: "default".into(),
                permission: "bypassPermissions".into(),
                reasoning: "default".into(),
                enabled,
                system_prompt: prompt.into(),
                expected_revision: revision,
                capability,
                updated_at_epoch_ms: 2,
            })
    }
}

#[test]
fn a_stale_configuration_application_cannot_overwrite_a_newer_steward_change() {
    let mut fixture = Fixture::new();
    let plan = fixture.restore_plan();
    fixture
        .change(
            "newer",
            true,
            fixture.core.state_revision(),
            AssistantAvailability::Proven,
        )
        .unwrap();
    let revision = fixture.core.state_revision();
    assert!(matches!(
        fixture
            .core
            .apply_owned_configuration_application(plan, AssistantAvailability::Proven, 3),
        Err(CoreError::RevisionConflict)
    ));
    assert_eq!(fixture.core.state_revision(), revision);
    assert_eq!(
        fixture.core.store.steward_configurations()[0].system_prompt,
        "newer"
    );
}

#[test]
fn a_post_commit_version_error_preserves_the_required_steward_effects() {
    let mut fixture = Fixture::new();
    let mut plan = fixture.restore_plan();
    let mut content: serde_json::Value = serde_json::from_str(&plan.content).unwrap();
    content["systemPrompt"] = json!("changed");
    plan.content = serde_json::to_string(&content).unwrap();
    // Exercise a failure in the second write, after the target and its
    // generic version have already committed successfully.
    plan.selected_existing_version_id = Some("missing-version".into());
    let commit = fixture
        .core
        .apply_owned_configuration_application(plan, AssistantAvailability::Proven, 3)
        .unwrap();
    assert!(matches!(commit.result, Err(CoreError::NotFound)));
    let change = commit.effects.steward_change.unwrap();
    assert!(change.changed());
    assert!(change.needs_wake());
    assert_eq!(change.retired_session_id(), Some("executor"));
    assert_eq!(
        fixture.core.store.steward_configurations()[0].system_prompt,
        "changed"
    );
    assert!(
        fixture
            .core
            .steward_executor_session_id(&fixture.project)
            .is_none()
    );
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn rejected_changes_produce_no_retirement_and_preserve_the_executor() {
    let mut fixture = Fixture::new();
    let revision = fixture.core.state_revision();
    for (expected, capability) in [
        (revision - 1, AssistantAvailability::Proven),
        (revision, AssistantAvailability::Unavailable),
    ] {
        assert!(
            fixture
                .change("changed", true, expected, capability)
                .is_err()
        );
        assert_eq!(fixture.core.state_revision(), revision);
        assert_eq!(
            fixture
                .core
                .steward_executor_session_id(&fixture.project)
                .as_deref(),
            Some("executor")
        );
        assert_eq!(fixture.core.store.sessions()[0].lifecycle_state, "running");
    }
    let path = fixture.root.join("state.json");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(
        fixture
            .change("changed", true, revision, AssistantAvailability::Proven)
            .is_err()
    );
    assert_eq!(fixture.core.state_revision(), revision);
    assert_eq!(
        fixture
            .core
            .steward_executor_session_id(&fixture.project)
            .as_deref(),
        Some("executor")
    );
}

#[test]
fn successful_change_captures_exact_retirement_and_generation_without_reaping() {
    let mut fixture = Fixture::new();
    let revision = fixture.core.state_revision();
    let commit = fixture
        .change("changed", true, revision, AssistantAvailability::Proven)
        .unwrap();
    assert_eq!(commit.change.retired_session_id(), Some("executor"));
    assert!(commit.change.changed());
    assert!(commit.change.needs_wake());
    assert_eq!(commit.change.generation(), 2);
    assert_eq!(
        commit.change.state_revision(),
        fixture.core.state_revision()
    );
    assert!(fixture.core.is_current_steward_change(&commit.change));
    assert!(
        fixture
            .core
            .steward_executor_session_id(&fixture.project)
            .is_none()
    );
    assert_eq!(fixture.core.store.sessions()[0].lifecycle_state, "running");
    let next = fixture
        .change(
            "disabled",
            false,
            fixture.core.state_revision(),
            AssistantAvailability::Proven,
        )
        .unwrap();
    assert!(!next.change.needs_wake());
    assert!(next.change.changed());
    assert!(!fixture.core.is_current_steward_change(&commit.change));
}

#[test]
fn unchanged_configuration_keeps_a_live_executor_and_requeues_only_if_absent() {
    let mut fixture = Fixture::new();
    let commit = fixture
        .change(
            "original",
            true,
            fixture.core.state_revision(),
            AssistantAvailability::Proven,
        )
        .unwrap();
    assert!(!commit.change.changed());
    assert!(!commit.change.needs_wake());
    assert!(commit.change.retired_session_id().is_none());
    fixture
        .core
        .store
        .mark_session_exited(&fixture.core.write_authority, "executor")
        .unwrap();
    let commit = fixture
        .change(
            "original",
            true,
            fixture.core.state_revision(),
            AssistantAvailability::Proven,
        )
        .unwrap();
    assert!(!commit.change.changed());
    assert!(commit.change.needs_wake());
    assert!(commit.change.retired_session_id().is_none());
}
