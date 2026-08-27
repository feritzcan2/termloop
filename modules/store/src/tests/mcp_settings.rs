use super::*;
use termloop_domain::{McpToolDescription, McpToolName};

#[test]
fn mcp_description_override_replaces_resets_and_uses_revision_cas() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-mcp-settings-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    let initial_revision = store.revision();
    let description = McpToolDescription::new("Use the exact helper workflow.".into()).unwrap();

    let updated_revision = store
        .update_mcp_tool_description(
            &authority,
            McpToolName::AskTo,
            description.clone(),
            initial_revision,
        )
        .unwrap();
    assert!(updated_revision > initial_revision);
    assert_eq!(
        store.mcp_tool_description_overrides()[0].description,
        description
    );
    assert!(matches!(
        store.update_mcp_tool_description(
            &authority,
            McpToolName::AskTo,
            McpToolDescription::new("Stale write".into()).unwrap(),
            initial_revision,
        ),
        Err(StoreError::RevisionConflict)
    ));

    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.mcp_tool_description_overrides().len(), 1);
    let reset_revision = reopened
        .reset_mcp_tool_description(&authority, McpToolName::AskTo, updated_revision)
        .unwrap();
    assert!(reset_revision > updated_revision);
    assert!(reopened.mcp_tool_description_overrides().is_empty());
    let _ = std::fs::remove_file(path);
}
