use super::*;
use termloop_domain::{
    ImproverSessionTarget, ImproverSessionTargetKind, ProjectRecord, RunConfiguration,
    RunConfigurationKind, RunSetupPolicy,
};

fn configuration(command: &str, updated_at_epoch_ms: u64) -> RunConfiguration {
    RunConfiguration {
        id: "run-1".into(),
        project_id: "project-1".into(),
        name: "Development".into(),
        kind: RunConfigurationKind::DevServer,
        command: command.into(),
        working_directory: ".".into(),
        env: vec![],
        setup_command: None,
        setup_policy: RunSetupPolicy::Never,
        url_auto_detect: true,
        fallback_urls: vec![],
        auto_open_first_url: false,
        generation: updated_at_epoch_ms,
        updated_at_epoch_ms,
    }
}

fn target() -> ImproverSessionTarget {
    ImproverSessionTarget {
        target_kind: ImproverSessionTargetKind::RunConfiguration,
        target_id: Some("run-1".into()),
    }
}

#[test]
fn each_save_replaces_the_previous_snapshot_and_advances_its_sequence() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-configuration-version-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-1".into(),
                name: "Project".into(),
                folder_path: "/tmp/project-1".into(),
            },
        )
        .unwrap();

    store
        .set_run_configuration(
            &authority,
            configuration("npm run dev", 1),
            store.revision(),
        )
        .unwrap();
    let first = store
        .active_configuration_version("project-1", &target())
        .unwrap()
        .clone();
    assert_eq!(first.sequence, 1);
    store
        .set_run_configuration(&authority, configuration("pnpm dev", 2), store.revision())
        .unwrap();
    let second = store
        .active_configuration_version("project-1", &target())
        .unwrap()
        .clone();
    assert_eq!(second.sequence, 2);
    assert_eq!(
        store.configuration_versions(),
        std::slice::from_ref(&second)
    );

    // An earlier snapshot is gone, so it can no longer be selected.
    assert!(matches!(
        store.select_configuration_version(
            &authority,
            "project-1",
            &target(),
            Some(&second.id),
            &first.id,
            &first.content,
        ),
        Err(StoreError::NotFound)
    ));
    // Selecting the active snapshot stays a valid no-op.
    let reselected = store
        .select_configuration_version(
            &authority,
            "project-1",
            &target(),
            Some(&second.id),
            &second.id,
            &second.content,
        )
        .unwrap();
    assert_eq!(reselected.id, second.id);

    let unchanged = store
        .finalize_configuration_activation(
            &authority,
            "project-1",
            &target(),
            Some(&second.id),
            &second.content,
            "Agent update",
            Some("agent-session-1"),
            5,
        )
        .unwrap();
    assert_eq!(unchanged.id, second.id);
    assert_eq!(store.configuration_versions().len(), 1);

    store
        .set_run_configuration(&authority, configuration("bun dev", 6), store.revision())
        .unwrap();
    let changed_content = store
        .active_configuration_version("project-1", &target())
        .unwrap()
        .content
        .clone();
    let agent_version = store
        .finalize_configuration_activation(
            &authority,
            "project-1",
            &target(),
            Some(&second.id),
            &changed_content,
            "Agent update",
            Some("agent-session-1"),
            7,
        )
        .unwrap();
    assert_eq!(agent_version.sequence, 3);
    assert_eq!(
        agent_version.source_session_id.as_deref(),
        Some("agent-session-1")
    );
    assert_eq!(
        store.configuration_versions(),
        std::slice::from_ref(&agent_version)
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn loading_current_state_drops_every_snapshot_but_the_selected_one() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-configuration-version-prune-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-1".into(),
                name: "Project".into(),
                folder_path: "/tmp/project-1".into(),
            },
        )
        .unwrap();
    store
        .set_run_configuration(&authority, configuration("pnpm dev", 2), store.revision())
        .unwrap();
    let active = store
        .active_configuration_version("project-1", &target())
        .unwrap()
        .clone();
    drop(store);

    // Write the history an older daemon kept beside the active snapshot.
    let mut persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let mut older = persisted["configuration_versions"][0].clone();
    older["id"] = "older-version".into();
    older["sequence"] = 1.into();
    persisted["configuration_versions"]
        .as_array_mut()
        .unwrap()
        .insert(0, older);
    std::fs::write(&path, serde_json::to_vec(&persisted).unwrap()).unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.configuration_versions(),
        std::slice::from_ref(&active)
    );
    let rewritten: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        rewritten["configuration_versions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_40_migrates_the_newest_snapshot_to_the_active_pointer() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-configuration-version-migration-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 40,
            "revision": 2,
            "projects": [{"id":"project-1","name":"Project","folder_path":"/tmp/project-1"}],
            "configuration_versions": [
                {
                    "id": "version-1",
                    "projectId": "project-1",
                    "target": {"target_kind":"settingsSkill","target_id":"skill-1"},
                    "sequence": 1,
                    "content": "first",
                    "summary": "",
                    "createdAtEpochMs": 1
                },
                {
                    "id": "version-2",
                    "projectId": "project-1",
                    "target": {"target_kind":"settingsSkill","target_id":"skill-1"},
                    "sequence": 2,
                    "content": "second",
                    "summary": "",
                    "createdAtEpochMs": 2
                }
            ],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    let skill_target = ImproverSessionTarget {
        target_kind: ImproverSessionTargetKind::SettingsSkill,
        target_id: Some("skill-1".into()),
    };
    assert_eq!(
        store
            .active_configuration_version("project-1", &skill_target)
            .unwrap()
            .id,
        "version-2"
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["configuration_version_selections"][0]["versionId"],
        "version-2"
    );
    let _ = std::fs::remove_file(path);
}
