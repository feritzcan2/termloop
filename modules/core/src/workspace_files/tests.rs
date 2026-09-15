use super::*;
use serde_json::json;
use termloop_store::Store;
use termloop_terminal::TerminalService;

#[test]
fn file_reads_are_ephemeral_and_revalidate_project_roots() {
    let root = std::env::temp_dir().join(format!("core-files-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("project")).unwrap();
    std::fs::create_dir_all(root.join("other")).unwrap();
    std::fs::write(root.join("project/file"), "EPHEMERAL_FILE_MARKER").unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut core = CoreRuntime::new(
        Store::open(root.join("state.json")).unwrap(),
        authority,
        TerminalService::default(),
        1,
    )
    .unwrap();
    let project = core
        .create_project(json!({"name":"files", "folderPath":root.join("project")}))
        .unwrap();
    let id = project["id"].as_str().unwrap();
    let revision = core.state_revision();
    let list = core
        .plan_workspace_files(id, None, "")
        .unwrap()
        .observe_directory();
    assert_eq!(
        core.complete_workspace_files(list).unwrap()["entries"][0]["name"],
        "file"
    );
    let read = core
        .plan_workspace_files(id, None, "file")
        .unwrap()
        .observe_file();
    assert_eq!(
        core.complete_workspace_files(read).unwrap()["content"],
        "EPHEMERAL_FILE_MARKER"
    );
    assert_eq!(core.state_revision(), revision);
    assert!(
        !std::fs::read_to_string(root.join("state.json"))
            .unwrap()
            .contains("EPHEMERAL_FILE_MARKER")
    );
    assert!(matches!(
        core.plan_workspace_files("missing", None, ""),
        Err(CoreError::NotFound)
    ));
    assert!(matches!(
        core.plan_workspace_files(id, Some("missing"), ""),
        Err(CoreError::NotFound)
    ));
    assert!(matches!(
        core.plan_workspace_files(id, None, "../outside"),
        Err(CoreError::InvalidParams(_))
    ));
    let stale = core
        .plan_workspace_files(id, None, "file")
        .unwrap()
        .observe_file();
    core.update_project_details(
        json!({"projectId":id, "name":"files", "folderPath":root.join("other")}),
    )
    .unwrap();
    assert!(matches!(
        core.complete_workspace_files(stale),
        Err(CoreError::RepositoryUnavailable)
    ));
    drop(core);
    std::fs::remove_dir_all(root).unwrap();
}
