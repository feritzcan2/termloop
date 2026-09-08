use super::*;
use termloop_domain::{AgentAccount, AgentAccountProvider};

#[test]
fn account_metadata_is_revision_checked_bounded_and_persists_without_provider_data() {
    let root = std::env::temp_dir().join(format!(
        "termloop-accounts-{}",
        termloop_platform::generate_uuid_v4()
    ));
    let path = root.join("state.json");
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    let provider = AgentAccountProvider::Codex;
    let id = termloop_platform::generate_uuid_v4();
    let account = AgentAccount {
        agent_id: provider,
        account_id: id.clone(),
        name: "Work".into(),
        is_default: false,
    };
    let revision = store
        .create_agent_account(&authority, account.clone(), 0)
        .unwrap();
    assert!(matches!(
        store.set_default_agent_account(&authority, provider, &id, 0),
        Err(StoreError::RevisionConflict)
    ));
    assert!(matches!(
        store.create_agent_account(&authority, account, revision),
        Err(StoreError::ConstraintViolation)
    ));
    assert!(matches!(
        store.rename_agent_account(&authority, provider, &id, "Default account", revision),
        Err(StoreError::ConstraintViolation)
    ));
    let revision = store
        .rename_agent_account(&authority, provider, &id, "Personal", revision)
        .unwrap();
    assert_eq!(
        store
            .rename_agent_account(&authority, provider, &id, "Personal", revision)
            .unwrap(),
        revision
    );
    let revision = store
        .set_default_agent_account(&authority, provider, &id, revision)
        .unwrap();
    assert_eq!(
        store
            .set_default_agent_account(&authority, provider, &id, revision)
            .unwrap(),
        revision
    );
    for index in 0..14 {
        store
            .create_agent_account(
                &authority,
                AgentAccount {
                    agent_id: provider,
                    account_id: termloop_platform::generate_uuid_v4(),
                    name: format!("Extra {index}"),
                    is_default: false,
                },
                store.revision(),
            )
            .unwrap();
    }
    assert!(matches!(
        store.create_agent_account(
            &authority,
            AgentAccount {
                agent_id: provider,
                account_id: termloop_platform::generate_uuid_v4(),
                name: "Too many".into(),
                is_default: false
            },
            store.revision()
        ),
        Err(StoreError::ConstraintViolation)
    ));
    let reopened = Store::open(&path).unwrap();
    assert_eq!(store.agent_accounts(), reopened.agent_accounts());
    let bytes = std::fs::read_to_string(&path).unwrap();
    assert!(!bytes.contains("CODEX_HOME"));
    assert!(!bytes.contains("auth.json"));
    assert!(
        !root.join("agent-accounts").exists(),
        "metadata writes must not create credential stores"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn version_57_migration_seeds_accounts_without_rebinding_legacy_selections() {
    let mut previous = serde_json::to_value(CurrentState::default()).unwrap();
    previous["schema_version"] = json!(57);
    previous.as_object_mut().unwrap().remove("agent_accounts");
    let (state, migrated) =
        crate::migration::decode_and_migrate_state(&serde_json::to_vec(&previous).unwrap())
            .unwrap();
    assert!(migrated);
    assert_eq!(state.schema_version, CURRENT_SCHEMA_VERSION);
    assert_eq!(
        state.agent_accounts,
        termloop_domain::default_agent_accounts()
    );
    let mut restored = serde_json::to_value(state).unwrap();
    restored.as_object_mut().unwrap().remove("agent_accounts");
    restored["schema_version"] = json!(57);
    assert_eq!(restored, previous);
    let selection: termloop_domain::AgentLaunchSelection = serde_json::from_value(
        json!({"model":"default","permission":"default","reasoning":"default"}),
    )
    .unwrap();
    assert_eq!(selection.account_id, None);
}

#[test]
fn a_failed_account_commit_restores_the_previous_metadata() {
    let root = std::env::temp_dir().join(format!(
        "termloop-accounts-failure-{}",
        termloop_platform::generate_uuid_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("state.json");
    let mut store = Store::open(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(
        store
            .create_agent_account(
                &issue_core_write_authority_for_composition(),
                AgentAccount {
                    agent_id: AgentAccountProvider::Claude,
                    account_id: termloop_platform::generate_uuid_v4(),
                    name: "Work".into(),
                    is_default: false
                },
                0
            )
            .is_err()
    );
    assert_eq!(store.revision(), 0);
    assert_eq!(
        store.agent_accounts(),
        termloop_domain::default_agent_accounts()
    );
    std::fs::remove_dir_all(root).unwrap();
}
