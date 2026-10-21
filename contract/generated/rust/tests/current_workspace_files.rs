use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

#[test]
fn workspace_content_is_full_control_only_and_has_no_ambient_root_input() {
    for method in ["workspace.directoryList", "workspace.fileRead"] {
        assert!(METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
        assert!(!COMPANION_METHODS.contains(&method));
        assert!(validate_method_params(
            method,
            &json!({"projectId":"p", "taskId":null, "path":""})
        ));
        assert!(validate_method_params(
            method,
            &json!({"projectId":"p", "taskId":"t", "path":"src/a.rs"})
        ));
        assert!(!validate_method_params(
            method,
            &json!({"projectId":"p", "taskId":null, "path":"", "root":"/"})
        ));
        assert!(!validate_method_params(
            method,
            &json!({"projectId":"p", "taskId":null, "path":"a".repeat(4097)})
        ));
    }
}

#[test]
fn workspace_results_are_closed_and_bounded() {
    let entry = json!({"name":"a", "path":"a", "kind":"file"});
    assert!(validate_method_result(
        "workspace.directoryList",
        &json!({"path":"", "entries":[entry.clone()], "truncated":false})
    ));
    assert!(!validate_method_result(
        "workspace.directoryList",
        &json!({"path":"", "entries":vec![entry; 2001], "truncated":false})
    ));
    assert!(validate_method_params(
        "workspace.directoryList",
        &json!({"projectId":"p", "taskId":null, "path":"", "afterName":"file-2000"})
    ));
    assert!(!validate_method_params(
        "workspace.directoryList",
        &json!({"projectId":"p", "taskId":null, "path":"", "afterName":""})
    ));
    assert!(validate_method_result(
        "workspace.directoryList",
        &json!({"path":"", "entries":[], "truncated":true, "next_name":"file-2000", "omitted":false})
    ));
    assert!(!validate_method_result(
        "workspace.directoryList",
        &json!({"path":"", "entries":[], "truncated":true, "next_name":""})
    ));
    for state in ["text", "binary", "tooLarge", "symlink", "unsupported"] {
        assert!(validate_method_result(
            "workspace.fileRead",
            &json!({"path":"a", "state":state, "content":null})
        ));
    }
    assert!(!validate_method_result(
        "workspace.fileRead",
        &json!({"path":"a", "state":"text", "content":"a".repeat(262145)})
    ));
}

#[test]
fn workspace_file_search_is_full_control_only_bounded_and_has_no_root_input() {
    let method = "workspace.fileSearch";
    assert!(METHODS.contains(&method));
    assert!(!READ_ONLY_METHODS.contains(&method));
    assert!(!COMPANION_METHODS.contains(&method));
    assert!(validate_method_params(
        method,
        &json!({"projectId":"p", "taskId":null, "query":"app"})
    ));
    assert!(!validate_method_params(
        method,
        &json!({"projectId":"p", "taskId":null, "query":""})
    ));
    assert!(!validate_method_params(
        method,
        &json!({"projectId":"p", "taskId":null, "query":"a".repeat(513)})
    ));
    assert!(!validate_method_params(
        method,
        &json!({"projectId":"p", "taskId":null, "query":"a", "path":"/"})
    ));
    let entry = json!({"name":"a", "path":"a", "kind":"file"});
    assert!(validate_method_result(
        method,
        &json!({"query":"a", "entries":[entry.clone()], "total":9, "incomplete":false, "unreadable":true})
    ));
    assert!(!validate_method_result(
        method,
        &json!({"query":"a", "entries":vec![entry; 201], "total":201, "incomplete":false, "unreadable":false})
    ));
}

#[test]
fn workspace_file_write_is_full_control_only_and_requires_a_read_version() {
    let method = "workspace.fileWrite";
    let version = "a".repeat(64);
    assert!(METHODS.contains(&method));
    assert!(!READ_ONLY_METHODS.contains(&method));
    assert!(!COMPANION_METHODS.contains(&method));
    let params = |path: &str, content: String, expected: &str| json!({"projectId":"p", "taskId":null, "path":path, "content":content, "expectedVersion":expected});
    assert!(validate_method_params(
        method,
        &params("a.ts", "x".into(), &version)
    ));
    assert!(validate_method_params(
        method,
        &params("a.ts", String::new(), &version)
    ));
    assert!(!validate_method_params(
        method,
        &params("", "x".into(), &version)
    ));
    assert!(!validate_method_params(
        method,
        &params("a.ts", "x".into(), "ABC")
    ));
    assert!(!validate_method_params(
        method,
        &params("a.ts", "a".repeat(262145), &version)
    ));
    assert!(!validate_method_params(
        method,
        &json!({"projectId":"p", "taskId":null, "path":"a.ts", "content":"x"})
    ));
    assert!(validate_method_result(
        method,
        &json!({"path":"a.ts", "state":"written", "version":version})
    ));
    assert!(validate_method_result(
        method,
        &json!({"path":"a.ts", "state":"conflict", "version":null})
    ));
    assert!(!validate_method_result(
        method,
        &json!({"path":"a.ts", "state":"saved", "version":version})
    ));
    assert!(validate_method_result(
        "workspace.fileRead",
        &json!({"path":"a", "state":"text", "content":"x", "version":version})
    ));
    assert!(!validate_method_result(
        "workspace.fileRead",
        &json!({"path":"a", "state":"text", "content":"x", "version":"nothex"})
    ));
}
