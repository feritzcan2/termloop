use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

const SOURCE_CONTROL_METHODS: [&str; 8] = [
    "sourceControl.status",
    "sourceControl.stage",
    "sourceControl.unstage",
    "sourceControl.discard",
    "sourceControl.commit",
    "sourceControl.push",
    "sourceControl.pull",
    "sourceControl.fetch",
];

#[test]
fn source_control_is_full_control_only_and_addresses_a_root_not_a_path() {
    for method in SOURCE_CONTROL_METHODS {
        assert!(METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
        assert!(!COMPANION_METHODS.contains(&method));
    }
    for method in [
        "sourceControl.status",
        "sourceControl.push",
        "sourceControl.pull",
        "sourceControl.fetch",
    ] {
        assert!(validate_method_params(
            method,
            &json!({"projectId":"p", "taskId":null})
        ));
        assert!(!validate_method_params(
            method,
            &json!({"projectId":"p", "taskId":null, "remote":"evil"})
        ));
    }
    for method in [
        "sourceControl.stage",
        "sourceControl.unstage",
        "sourceControl.discard",
    ] {
        let params = |ids: serde_json::Value| json!({"projectId":"p", "taskId":"t", "observationId":"source-control-1", "entryIds":ids});
        assert!(validate_method_params(method, &params(json!(["entry-0"]))));
        assert!(!validate_method_params(method, &params(json!([]))));
        assert!(!validate_method_params(
            method,
            &params(json!(vec!["entry-0"; 513]))
        ));
        assert!(!validate_method_params(
            method,
            &json!({"projectId":"p", "taskId":null, "observationId":"o", "entryIds":["entry-0"], "path":"/"})
        ));
    }
    assert!(validate_method_params(
        "sourceControl.commit",
        &json!({"projectId":"p", "taskId":null, "message":"Fix"})
    ));
    assert!(!validate_method_params(
        "sourceControl.commit",
        &json!({"projectId":"p", "taskId":null, "message":""})
    ));
    assert!(!validate_method_params(
        "sourceControl.commit",
        &json!({"projectId":"p", "taskId":null, "message":"a".repeat(65_537)})
    ));
}

#[test]
fn source_control_results_are_closed() {
    let branch = json!({
        "name":"main", "head_state":"attached", "upstream":"origin/main",
        "upstream_gone":false, "ahead":1, "behind":0,
    });
    let entry = json!({
        "entry_id":"entry-0", "display_path":"a.txt", "original_display_path":null,
        "path_encoding":"utf8", "side":"unstaged", "kind":"modified", "render_state":"available",
    });
    assert!(validate_method_result(
        "sourceControl.status",
        &json!({"project_id":"p", "task_id":null, "observation_id":"source-control-1",
            "branch":branch, "entries":[entry], "truncated":false})
    ));
    assert!(!validate_method_result(
        "sourceControl.status",
        &json!({"project_id":"p", "task_id":null, "observation_id":"source-control-1",
            "branch":{"name":null, "head_state":"rebasing", "upstream":null,
                "upstream_gone":false, "ahead":null, "behind":null},
            "entries":[], "truncated":false})
    ));
    assert!(validate_method_result(
        "sourceControl.stage",
        &json!({"project_id":"p", "task_id":"t"})
    ));
    assert!(validate_method_result(
        "sourceControl.commit",
        &json!({"project_id":"p", "task_id":null, "head_oid":"0".repeat(40)})
    ));
    assert!(!validate_method_result(
        "sourceControl.commit",
        &json!({"project_id":"p", "task_id":null, "head_oid":"HEAD"})
    ));
    for action in ["push", "publish", "pull", "fetch"] {
        assert!(validate_method_result(
            "sourceControl.push",
            &json!({"project_id":"p", "task_id":null, "action":action})
        ));
    }
    assert!(!validate_method_result(
        "sourceControl.push",
        &json!({"project_id":"p", "task_id":null, "action":"force"})
    ));
}
