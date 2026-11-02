use super::*;
use termloop_domain::AgentForkPreference;

fn state_path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "termloop-store-agent-fork-{label}-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

/// A state written before the preference existed keeps the fork notice on.
#[test]
fn a_state_without_the_fork_preference_enables_the_fork_notice() {
    let path = state_path("default");
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "schema_version": CURRENT_SCHEMA_VERSION,
            "revision": 2,
            "projects": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.agent_fork_preference().system_prompt_enabled);
    let _ = std::fs::remove_file(path);
}

#[test]
fn fork_preference_replaces_in_place_is_idempotent_and_persists() {
    let path = state_path("write");
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    let initial_revision = store.revision();
    let disabled = AgentForkPreference {
        system_prompt_enabled: false,
    };

    let written = store
        .set_agent_fork_preference(&authority, disabled)
        .unwrap();
    assert!(written > initial_revision);
    assert_eq!(store.agent_fork_preference(), disabled);
    assert_eq!(
        store
            .set_agent_fork_preference(&authority, disabled)
            .unwrap(),
        written
    );

    let reopened = Store::open(&path).unwrap();
    assert!(!reopened.agent_fork_preference().system_prompt_enabled);
    let _ = std::fs::remove_file(path);
}
