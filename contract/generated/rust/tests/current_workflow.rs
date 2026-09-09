use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params,
};

#[test]
fn project_workflow_methods_are_full_control_only_and_require_exact_previewed_scope() {
    let preview =
        json!({"projectId":"project-1", "workflowId":"workflow-1", "goal":"Build and verify"});
    assert!(validate_method_params("project.previewWorkflow", &preview));
    assert!(!validate_method_params("project.launchWorkflow", &preview));
    let mut launch = preview.clone();
    launch["launchTicket"] = json!("a".repeat(64));
    assert!(validate_method_params("project.launchWorkflow", &launch));
    for key in ["taskId", "cwd", "agentId", "permission"] {
        let mut extra = preview.clone();
        extra[key] = json!("arbitrary");
        assert!(!validate_method_params("project.previewWorkflow", &extra));
    }
    for goal in ["".to_owned(), "  ".into(), "x".repeat(8193)] {
        let mut invalid = preview.clone();
        invalid["goal"] = json!(goal);
        assert!(!validate_method_params("project.previewWorkflow", &invalid));
    }
    for method in ["project.previewWorkflow", "project.launchWorkflow"] {
        assert!(METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
        assert!(!COMPANION_METHODS.contains(&method));
    }
}
