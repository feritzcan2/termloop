use super::*;
use serde_json::json;
use termloop_store::Store;
use termloop_terminal::TerminalService;

fn project_checkout() -> (PathBuf, CoreRuntime, String) {
    let root = std::env::temp_dir().join(format!("core-source-control-{}", uuid::Uuid::new_v4()));
    let checkout = root.join("project");
    std::fs::create_dir_all(&checkout).unwrap();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &checkout).unwrap();
    for (key, value) in [
        ("user.name", "TermLoop Fixture"),
        ("user.email", "fixture@termloop.invalid"),
        ("commit.gpgsign", "false"),
        ("core.hooksPath", "/dev/null"),
    ] {
        termloop_gitio::test_support::set_config(&runner, &checkout, key, value).unwrap();
    }
    std::fs::write(checkout.join("tracked.txt"), "base\n").unwrap();
    termloop_gitio::test_support::commit_all(&runner, &checkout, "base").unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut core = CoreRuntime::new(
        Store::open(root.join("state.json")).unwrap(),
        authority,
        TerminalService::default(),
        1,
    )
    .unwrap();
    let project = core
        .create_project(json!({"name": "source control", "folderPath": checkout}))
        .unwrap();
    let id = project["id"].as_str().unwrap().to_owned();
    (checkout, core, id)
}

fn status(core: &mut CoreRuntime, project_id: &str) -> Value {
    let plan = core
        .plan_source_control_root(&json!({"projectId": project_id, "taskId": null}))
        .unwrap();
    core.complete_source_control_status(plan.observe_status())
        .unwrap()
}

fn entry_id(status: &Value, path: &str, side: &str) -> String {
    status["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["display_path"] == path && entry["side"] == side)
        .unwrap_or_else(|| panic!("no {side} entry for {path}"))["entry_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn apply(
    core: &CoreRuntime,
    plan: Result<SourceControlMutationPlan, CoreError>,
) -> Result<Value, CoreError> {
    core.complete_source_control_mutation(plan?.execute())
}

#[test]
fn stage_unstage_discard_and_commit_follow_one_status_read() {
    let (checkout, mut core, id) = project_checkout();
    std::fs::write(checkout.join("tracked.txt"), "edited\n").unwrap();
    std::fs::write(checkout.join("new.txt"), "new\n").unwrap();
    let revision = core.state_revision();

    let first = status(&mut core, &id);
    assert_eq!(first["branch"]["name"], "main");
    assert_eq!(first["branch"]["head_state"], "attached");
    assert_eq!(first["branch"]["upstream"], Value::Null);
    let params = |observation: &Value, ids: Vec<String>| {
        json!({
            "projectId": id,
            "taskId": null,
            "observationId": observation["observation_id"],
            "entryIds": ids,
        })
    };

    let stage = params(
        &first,
        vec![
            entry_id(&first, "tracked.txt", "unstaged"),
            entry_id(&first, "new.txt", "untracked"),
        ],
    );
    let staged = apply(&core, core.plan_source_control_stage(&stage)).unwrap();
    assert_eq!(staged["project_id"], id.as_str());
    let second = status(&mut core, &id);
    entry_id(&second, "tracked.txt", "staged");
    entry_id(&second, "new.txt", "staged");

    // Discard refuses staged work, and an entry list from another read is stale.
    let staged_ids = vec![entry_id(&second, "new.txt", "staged")];
    assert!(matches!(
        core.plan_source_control_discard(&params(&second, staged_ids.clone())),
        Err(CoreError::SourceControlRefused {
            reason: SourceControlRefusal::EntriesNotApplicable
        })
    ));
    assert!(matches!(
        core.plan_source_control_stage(&json!({
            "projectId": id, "observationId": "source-control-999", "entryIds": ["entry-0"],
        })),
        Err(CoreError::SourceControlRefused {
            reason: SourceControlRefusal::ObservationStale
        })
    ));
    apply(
        &core,
        core.plan_source_control_unstage(&params(&second, staged_ids)),
    )
    .unwrap();
    let third = status(&mut core, &id);
    let discard = params(&third, vec![entry_id(&third, "new.txt", "untracked")]);
    apply(&core, core.plan_source_control_discard(&discard)).unwrap();
    assert!(!checkout.join("new.txt").exists());
    assert_eq!(
        std::fs::read_to_string(checkout.join("tracked.txt")).unwrap(),
        "edited\n"
    );

    assert!(matches!(
        core.plan_source_control_commit(&json!({"projectId": id, "message": "  \n"})),
        Err(CoreError::SourceControlRefused {
            reason: SourceControlRefusal::EmptyMessage
        })
    ));
    let committed = apply(
        &core,
        core.plan_source_control_commit(&json!({"projectId": id, "message": "Edit tracked"})),
    )
    .unwrap();
    assert_eq!(committed["head_oid"].as_str().unwrap().len(), 40);
    assert_eq!(status(&mut core, &id)["entries"], json!([]));
    assert!(matches!(
        apply(
            &core,
            core.plan_source_control_commit(&json!({"projectId": id, "message": "again"}))
        ),
        Err(CoreError::SourceControlRefused {
            reason: SourceControlRefusal::NothingToCommit
        })
    ));
    // Source Control is Git work, never durable Project state.
    assert_eq!(core.state_revision(), revision);
}

#[test]
fn push_publishes_to_origin_when_the_branch_has_no_upstream() {
    let (checkout, mut core, id) = project_checkout();
    let remote = checkout.with_file_name("remote.git");
    std::fs::create_dir_all(&remote).unwrap();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_bare_repository(&runner, &remote).unwrap();
    termloop_gitio::test_support::set_remote_url(&runner, &checkout, "origin", &remote).unwrap();
    let push = json!({"projectId": id});
    let published = apply(
        &core,
        core.plan_source_control_sync(&push, SourceControlSync::Push),
    )
    .unwrap();
    assert_eq!(published["action"], "publish");
    let branch = &status(&mut core, &id)["branch"];
    assert_eq!(branch["upstream"], "origin/main");
    assert_eq!(branch["ahead"], 0);
    assert_eq!(
        apply(
            &core,
            core.plan_source_control_sync(&push, SourceControlSync::Push)
        )
        .unwrap()["action"],
        "push"
    );
    assert_eq!(
        apply(
            &core,
            core.plan_source_control_sync(&push, SourceControlSync::Fetch)
        )
        .unwrap()["action"],
        "fetch"
    );
}

#[test]
fn deleting_a_project_drops_its_cached_status() {
    let (_checkout, mut core, id) = project_checkout();
    let observation = status(&mut core, &id);
    assert_eq!(core.source_control_observations.entries.len(), 1);
    core.source_control_observations.retain_outside_project(&id);
    assert!(
        core.source_control_observations
            .selection(
                &core.source_control_root(&json!({"projectId": id})).unwrap(),
                observation["observation_id"].as_str().unwrap(),
                &[],
            )
            .is_none()
    );
}
