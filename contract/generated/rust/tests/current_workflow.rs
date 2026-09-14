use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params,
};

#[test]
fn workflow_creator_params_are_strict_and_full_control_only() {
    let params = json!({ "projectId": "project", "workflowId": null, "taskId": null, "draft": null,
        "agentId": "claude", "model": "default", "permission": "default", "reasoning": "default", "templateRef": "builtin.builder.workflow" });
    assert!(validate_method_params("workflow.creatorPreview", &params));
    let mut launch = params.clone();
    launch["launchTicket"] = json!("a".repeat(64));
    assert!(validate_method_params("workflow.creatorLaunch", &launch));
    for field in ["projectId", "workflowId", "taskId", "draft", "templateRef"] {
        let mut missing = params.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(
            !validate_method_params("workflow.creatorPreview", &missing),
            "{field}"
        );
    }
    for field in ["cwd", "executionId", "instructions"] {
        let mut extra = params.clone();
        extra[field] = json!("arbitrary");
        assert!(!validate_method_params("workflow.creatorPreview", &extra));
    }
    assert!(!validate_method_params("workflow.creatorLaunch", &params));
    let mut unsupported = params;
    unsupported["agentId"] = json!("gemini");
    assert!(!validate_method_params(
        "workflow.creatorPreview",
        &unsupported
    ));
    for method in [
        "workflow.creatorPreview",
        "workflow.creatorLaunch",
        "workflow.creatorDraftGet",
    ] {
        assert!(METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
        assert!(!COMPANION_METHODS.contains(&method));
    }
}

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
