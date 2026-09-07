use serde_json::{Value, json};
use termloop_domain::{AgentLaunchSelection, PersonalAgent};
use termloop_store::{Store, StoreError, issue_core_write_authority_for_composition};

fn agent() -> PersonalAgent {
    PersonalAgent {
        id: "custom.agent-profile.reviewer".into(),
        version: 1,
        name: "Reviewer".into(),
        description: "Review changes".into(),
        category: "Quality".into(),
        instructions: "Review and report findings.".into(),
        agent_id: "codex".into(),
        selection: AgentLaunchSelection::new("default", "plan", "high"),
    }
}

#[test]
fn agent_library_migrates_persists_and_rolls_back_failed_writes() {
    let root = std::env::temp_dir().join(format!(
        "termloop-store-agents-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("state.json");
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.update_personal_agent(&authority, agent(), 0).unwrap();
    let mut legacy: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    legacy["schema_version"] = json!(51);
    legacy.as_object_mut().unwrap().remove("agent_library");
    legacy
        .as_object_mut()
        .unwrap()
        .remove("session_agent_profiles");
    drop(store);
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let mut store = Store::open(&path).unwrap();
    assert!(store.agent_library().agents.is_empty());
    assert_eq!(store.agent_library().revision, 0);
    store.update_personal_agent(&authority, agent(), 0).unwrap();
    assert!(matches!(
        store.update_personal_agent(&authority, agent(), 0),
        Err(StoreError::RevisionConflict)
    ));
    store
        .favorite_agent_profile(&authority, &agent().id, true, 1)
        .unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.agent_library().agents, [agent()]);
    assert_eq!(store.agent_library().favorites, [agent().id]);
    let before = store.agent_library().clone();
    std::fs::rename(&path, root.join("backup.json")).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(
        store
            .delete_personal_agent(&authority, &agent().id, 2)
            .is_err()
    );
    assert_eq!(store.agent_library(), &before);
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(root.join("backup.json"), &path).unwrap();
    store
        .delete_personal_agent(&authority, &agent().id, 2)
        .unwrap();
    assert!(store.agent_library().favorites.is_empty());
    assert!(
        Store::open(&path)
            .unwrap()
            .agent_library()
            .agents
            .is_empty()
    );
    store.update_personal_agent(&authority, agent(), 3).unwrap();
    drop(store);
    let mut legacy: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    legacy["schema_version"] = json!(52);
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.agent_library().agents, [agent()]);
    let mut builtin = agent();
    builtin.id = "builtin.agent-profile.edge-case-hunter".into();
    builtin.version = 2;
    store
        .update_personal_agent(&authority, builtin.clone(), 4)
        .unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.agent_library().agents, [agent(), builtin.clone()]);
    drop(store);
    let mut legacy: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    legacy["schema_version"] = json!(53);
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.agent_library().agents, [agent(), builtin]);
    drop(store);
    let _ = std::fs::remove_dir_all(root);
}
