use super::*;
use termloop_domain::AgentRestartPreference;

fn state_path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "termloop-store-agent-restart-{label}-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

/// A state written before the preference existed keeps auto-continue off.
#[test]
fn a_state_without_the_restart_preference_disables_auto_continue() {
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
    assert!(!store.agent_restart_preference().auto_continue_interrupted);
    let _ = std::fs::remove_file(path);
}

#[test]
fn restart_preference_replaces_in_place_is_idempotent_and_persists() {
    let path = state_path("write");
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    let initial_revision = store.revision();
    let enabled = AgentRestartPreference {
        auto_continue_interrupted: true,
    };

    let written = store
        .set_agent_restart_preference(&authority, enabled)
        .unwrap();
    assert!(written > initial_revision);
    assert_eq!(store.agent_restart_preference(), enabled);
    assert_eq!(
        store
            .set_agent_restart_preference(&authority, enabled)
            .unwrap(),
        written
    );

    let reopened = Store::open(&path).unwrap();
    assert!(
        reopened
            .agent_restart_preference()
            .auto_continue_interrupted
    );
    let _ = std::fs::remove_file(path);
}
