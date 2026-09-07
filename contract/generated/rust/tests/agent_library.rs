use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, MCP_AGENT_CREATOR_TOOLS, MCP_HELPER_TOOLS, MCP_IMPROVER_TOOLS,
    MCP_INTERACTIVE_TOOLS, MCP_STEWARD_TOOLS, METHODS, READ_ONLY_METHODS, validate_mcp_tool_params,
    validate_method_params,
};

#[test]
fn agent_library_mutations_are_strict_and_full_control_only() {
    for method in [
        "agent.creatorPreview",
        "agent.creatorLaunch",
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

#[test]
fn creator_tools_require_complete_bounded_drafts_and_have_an_exclusive_role() {
    assert_eq!(
        MCP_AGENT_CREATOR_TOOLS,
        [
            "ask_to",
            "send_to_agent",
            "agent_library_read",
            "agent_profile_create"
        ]
    );
    for role in [
        MCP_IMPROVER_TOOLS,
        MCP_INTERACTIVE_TOOLS,
        MCP_STEWARD_TOOLS,
        MCP_HELPER_TOOLS,
    ] {
        assert!(!role.contains(&"agent_profile_create"));
        assert!(!role.contains(&"agent_library_read"));
    }
    assert!(validate_mcp_tool_params("agent_library_read", &json!({})));
    assert!(!validate_mcp_tool_params(
        "agent_library_read",
        &json!({"projectId":"other"})
    ));
    let draft = json!({"name":"Reviewer", "description":"Review changes", "category":"Quality", "instructions":"Inspect this", "agentId":"codex", "model":"default", "permission":"plan", "reasoning":"high", "expectedRevision":0});
    assert!(validate_mcp_tool_params("agent_profile_create", &draft));
    for field in ["expectedRevision", "instructions", "agentId", "permission"] {
        let mut incomplete = draft.clone();
        incomplete.as_object_mut().unwrap().remove(field);
        assert!(!validate_mcp_tool_params(
            "agent_profile_create",
            &incomplete
        ));
    }
    for (field, value) in [
        ("id", json!("existing")),
        ("tools", json!([])),
        ("instructions", json!("x".repeat(32769))),
        ("expectedRevision", json!(-1)),
    ] {
        let mut invalid = draft.clone();
        invalid[field] = value;
        assert!(!validate_mcp_tool_params("agent_profile_create", &invalid));
    }
    let params = json!({"projectId":"project", "agentId":"codex", "model":"default", "permission":"plan", "reasoning":"high", "templateRef":"builtin.builder.agent"});
    assert!(validate_method_params("agent.creatorPreview", &params));
    assert!(!validate_method_params("agent.creatorLaunch", &params));
    let mut launch = params;
    launch["launchTicket"] = json!("a".repeat(64));
    assert!(validate_method_params("agent.creatorLaunch", &launch));
    launch["templateRef"] = json!("builtin.improve.steward");
    assert!(!validate_method_params("agent.creatorLaunch", &launch));
}
