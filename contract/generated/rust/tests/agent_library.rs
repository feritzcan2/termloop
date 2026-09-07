use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params,
};

#[test]
fn agent_library_mutations_are_strict_and_full_control_only() {
    for method in [
        "agent.libraryGet",
        "agent.profileCreate",
        "agent.profileUpdate",
        "agent.profileDelete",
        "agent.profileFavorite",
    ] {
        assert!(METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
        assert!(!COMPANION_METHODS.contains(&method));
    }
    let mut draft = json!({"name":"Reviewer", "description":"Review changes", "category":"Quality", "instructions":"Inspect this", "agentId":"codex", "model":"default", "permission":"plan", "reasoning":"high", "expectedRevision":0});
    assert!(validate_method_params("agent.profileCreate", &draft));
    draft["instructions"] = json!("x".repeat(32769));
    assert!(!validate_method_params("agent.profileCreate", &draft));
    draft["instructions"] = json!("Inspect this");
    draft["tools"] = json!(["arbitrary"]);
    assert!(!validate_method_params("agent.profileCreate", &draft));
    assert!(validate_method_params(
        "quickAction.preview",
        &json!({"projectId":"p", "cwd":"/tmp", "agentId":"codex", "model":"default", "permission":"plan", "reasoning":"high", "templateRef":"custom.agent-profile.reviewer", "bindings":{"prompt":"Inspect changes"}, "attachments":[]})
    ));
}
