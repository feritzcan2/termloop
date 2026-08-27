use super::*;
use termloop_domain::{KeepAwakeMode, KeepAwakePreference};

fn state_path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "termloop-store-keep-awake-{label}-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

/// A state written before the preference existed must load as "off" rather
/// than failing or inventing a hold the user never asked for.
#[test]
fn schema_30_defaults_the_keep_awake_preference_to_off() {
    let path = state_path("migration");
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "schema_version": 30,
            "revision": 2,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.keep_awake_preference(),
        KeepAwakePreference {
            mode: KeepAwakeMode::Off,
            keep_display_awake: false,
            expires_at_epoch_ms: None,
        }
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    let _ = std::fs::remove_file(path);
}

#[test]
fn keep_awake_preference_replaces_in_place_and_is_idempotent() {
    let path = state_path("write");
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    let initial_revision = store.revision();

    let preference = KeepAwakePreference {
        mode: KeepAwakeMode::WhileAgentsRun,
        keep_display_awake: true,
        expires_at_epoch_ms: None,
    };
    let written = store
        .set_keep_awake_preference(&authority, preference)
        .unwrap();
    assert!(written > initial_revision);
    assert_eq!(store.keep_awake_preference(), preference);

    // Re-writing the same value must not churn the revision, so a UI that
    // re-submits its current selection cannot invalidate other readers.
    let repeated = store
        .set_keep_awake_preference(&authority, preference)
        .unwrap();
    assert_eq!(repeated, written);

    // The value is current state, not an append: switching modes replaces it.
    store
        .set_keep_awake_preference(
            &authority,
            KeepAwakePreference {
                mode: KeepAwakeMode::Always,
                keep_display_awake: false,
                expires_at_epoch_ms: None,
            },
        )
        .unwrap();
    assert_eq!(
        store.keep_awake_preference(),
        KeepAwakePreference {
            mode: KeepAwakeMode::Always,
            keep_display_awake: false,
            expires_at_epoch_ms: None,
        }
    );

    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.keep_awake_preference().mode, KeepAwakeMode::Always);
    let persisted = std::fs::read_to_string(&path).unwrap();
    assert!(
        !persisted.contains('\n'),
        "current-state snapshots stay compact to bound serialized lock time"
    );
    let _ = std::fs::remove_file(path);
}
