use termloop_contract::current::{
    AgentCapabilityListResult, CONTRACT_IDENTITY, ProtocolError, TaskLaunchAgentParams,
    TaskLaunchTerminalParams, validate_method_params,
};

#[test]
fn quick_action_surface_is_strict_and_full_control_only() {
    use termloop_contract::current::{METHODS, READ_ONLY_METHODS, validate_method_result};
    let params = serde_json::json!({
        "projectId":"project-1", "cwd":"/tmp/project", "agentId":"codex", "model":"gpt-5.6-sol",
        "permission":"plan", "reasoning":"high",
        "templateRef":"builtin.quick-action.free-prompt", "bindings":{"prompt":"Review this diff"},
        "attachments":[]
    });
    let digest = format!("sha256:{}", "0".repeat(64));
    assert!(validate_method_params("quickAction.preview", &params));
    let mut profile = params.clone();
    profile["templateRef"] =
        serde_json::json!("builtin.agent-profile.scattered-orchestration-finder");
    assert!(validate_method_params("quickAction.preview", &profile));
    profile["templateRef"] = serde_json::json!("builtin.agent-profile.Invalid");
    assert!(!validate_method_params("quickAction.preview", &profile));
    let mut gemini = params.clone();
    gemini["agentId"] = serde_json::json!("gemini");
    gemini["model"] = serde_json::json!("flash");
    gemini["reasoning"] = serde_json::json!("default");
    assert!(validate_method_params("quickAction.preview", &gemini));
    let mut malformed_agent = gemini.clone();
    malformed_agent["agentId"] = serde_json::json!("gemini--preview");
    assert!(!validate_method_params(
        "quickAction.preview",
        &malformed_agent
    ));
    assert!(!validate_method_params(
        "quickAction.preview",
        &serde_json::json!({"prompt":"raw"})
    ));
    let mut preview = serde_json::json!({
    "agent_id":"codex", "model":"gpt-5.6-sol", "permission":"plan", "reasoning":"high",
    "template_ref":"builtin.quick-action.free-prompt",
        "template_version":2, "delivery":"terminalInput", "delivered_preview":"Review this diff", "launch_ticket":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "manifest": {
            "digest":digest,
            "target":{"agent_id":"codex","executable":"codex","model":"gpt-5.6-sol","permission":"plan","reasoning":"high","cwd":"/tmp/project","conversation":"fresh"},
            "provenance":{"template_ref":"builtin.quick-action.free-prompt","template_version":2,"authored_digest":digest,"delivered_digest":digest},
            "content_parts":[{"id":"first-message","kind":"firstMessage","source":"template","scope":"launch","delivery":"terminalInput","content":"Review this diff","byte_length":16,"digest":digest}],
            "transport":{"kind":"terminalInput","delivered_content":"Review this diff","byte_length":16,"digest":digest},
            "arguments":[{
                "position":1,
                "display":"<redacted Quick Action image path>",
                "visibility":"redacted",
                "classification":"sensitivePath",
                "purpose":"Quick Action image attachment"
            }],"environment":[],"generated_files":[],"limitations":[]
        }
    });
    assert!(validate_method_result("quickAction.preview", &preview));

    preview["template_ref"] =
        serde_json::json!("builtin.agent-profile.scattered-orchestration-finder");
    preview["template_version"] = serde_json::json!(1);
    preview["manifest"]["provenance"]["template_ref"] = preview["template_ref"].clone();
    preview["manifest"]["provenance"]["template_version"] = serde_json::json!(1);
    preview["manifest"]["arguments"][0]["display"] = "x".repeat(4_237).into();
    assert!(validate_method_result("quickAction.preview", &preview));

    preview["manifest"]["arguments"][0]["display"] = "x".repeat(524_288).into();
    assert!(validate_method_result("quickAction.preview", &preview));

    preview["manifest"]["arguments"][0]["display"] = "x".repeat(524_289).into();
    assert!(!validate_method_result("quickAction.preview", &preview));
    let mut launch_params = params.clone();
    launch_params["launchTicket"] = serde_json::Value::String("a".repeat(64));
    assert!(validate_method_params("quickAction.launch", &launch_params));
    assert!(METHODS.contains(&"quickAction.launch"));
    assert!(!READ_ONLY_METHODS.contains(&"quickAction.preview"));
    assert!(!READ_ONLY_METHODS.contains(&"quickAction.launch"));
}

#[test]
fn agent_profile_catalog_is_strict_and_read_only() {
    use termloop_contract::current::{
        AgentProfileListResult, COMPANION_METHODS, METHODS, READ_ONLY_METHODS,
        validate_method_result,
    };

    assert!(validate_method_params(
        "agent.profileList",
        &serde_json::json!({})
    ));
    let result = serde_json::json!([{
        "id":"builtin.agent-profile.scattered-orchestration-finder",
        "name":"Scattered Orchestration Finder",
        "description":"Find write-side orchestration drift across owners.",
        "category":"Architecture",
        "version":1,
        "permission":"plan",
        "read_only":true,
        "user_invocable":true,
        "agent_ids":["claude","codex"]
    }]);
    assert!(validate_method_result("agent.profileList", &result));
    let profiles: AgentProfileListResult = serde_json::from_value(result.clone()).unwrap();
    assert_eq!(profiles[0].permission, "plan");
    assert!(profiles[0].read_only);

    let oversized = serde_json::Value::Array(vec![result[0].clone(); 65]);
    assert!(!validate_method_result("agent.profileList", &oversized));

    let mut extra = result;
    extra[0]["instructions"] = serde_json::json!("private prompt");
    assert!(!validate_method_result("agent.profileList", &extra));
    assert!(METHODS.contains(&"agent.profileList"));
    assert!(READ_ONLY_METHODS.contains(&"agent.profileList"));
    assert!(COMPANION_METHODS.contains(&"agent.profileList"));
}

#[test]
fn session_image_paste_is_strict_and_full_control_only() {
    use termloop_contract::current::{
        COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_result,
    };

    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let attachment = serde_json::json!({
        "attachmentId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "mediaType": "image/png",
        "byteLength": 128,
        "sha256": format!("sha256:{}", "c".repeat(64)),
        "width": 12,
        "height": 8
    });
    let params = serde_json::json!({
        "sessionId": session_id,
        "attachments": [attachment]
    });

    assert!(validate_method_params("session.pasteImage", &params));
    assert!(!validate_method_params(
        "session.pasteImage",
        &serde_json::json!({"sessionId": session_id, "attachments": []})
    ));
    assert!(!validate_method_params(
        "session.pasteImage",
        &serde_json::json!({
            "sessionId": session_id,
            "attachments": [attachment, attachment]
        })
    ));
    assert!(!validate_method_params(
        "session.pasteImage",
        &serde_json::json!({
            "sessionId": session_id,
            "attachments": [attachment],
            "provider": "codex"
        })
    ));
    assert!(validate_method_result(
        "session.pasteImage",
        &serde_json::json!({"sessionId": session_id, "status": "delivered"})
    ));
    assert!(!validate_method_result(
        "session.pasteImage",
        &serde_json::json!({"sessionId": session_id, "status": "queued"})
    ));
    assert!(METHODS.contains(&"session.pasteImage"));
    assert!(!READ_ONLY_METHODS.contains(&"session.pasteImage"));
    assert!(!COMPANION_METHODS.contains(&"session.pasteImage"));
}

#[test]
fn assistant_prompt_preview_accepts_large_routine_builder_content_and_remains_bounded() {
    use termloop_contract::current::validate_method_result;

    let digest = format!("sha256:{}", "0".repeat(64));
    let delivered = "x".repeat(256 * 1024);
    let preview = serde_json::json!({
        "agent_id":"codex", "model":"gpt-5.6-sol", "permission":"plan", "reasoning":"high",
        "template_ref":"builtin.builder.routine",
        "template_version":1, "delivery":"terminalInput", "delivered_preview":delivered,
        "launch_ticket":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "manifest": {
            "digest":digest,
            "target":{"agent_id":"codex","executable":"codex","model":"gpt-5.6-sol","permission":"plan","reasoning":"high","cwd":"/tmp/project","conversation":"fresh"},
            "provenance":{"template_ref":"builtin.builder.routine","template_version":1,"authored_digest":digest,"delivered_digest":digest},
            "content_parts":[{"id":"first-message","kind":"firstMessage","source":"resources/prompts/builtin.builder.routine","scope":"launch","delivery":"terminalInput","content":delivered,"byte_length":delivered.len(),"digest":digest}],
            "transport":{"kind":"terminalInput","delivered_content":delivered,"byte_length":delivered.len(),"digest":digest},
            "arguments":[],"environment":[],"generated_files":[],"limitations":[]
        }
    });
    assert!(validate_method_result(
        "assistantPrompt.improvePreview",
        &preview
    ));

    let oversized = "x".repeat(256 * 1024 + 1);
    let mut oversized_part = preview.clone();
    oversized_part["manifest"]["content_parts"][0]["content"] = oversized.clone().into();
    assert!(!validate_method_result(
        "assistantPrompt.improvePreview",
        &oversized_part
    ));

    let mut oversized_transport = preview;
    oversized_transport["manifest"]["transport"]["delivered_content"] = oversized.into();
    assert!(!validate_method_result(
        "assistantPrompt.improvePreview",
        &oversized_transport
    ));
}

#[test]
fn task_launch_and_capability_surface_is_generated() {
    assert!(CONTRACT_IDENTITY.starts_with("sha256:"));
    assert_eq!(CONTRACT_IDENTITY.len(), 71);
    assert!(validate_method_params(
        "task.launchTerminal",
        &serde_json::json!({"taskId":"task-1"})
    ));
    assert!(!validate_method_params(
        "task.launchTerminal",
        &serde_json::json!({"taskId":"task-1","cwd":"/unsafe"})
    ));
    let _: TaskLaunchTerminalParams =
        serde_json::from_value(serde_json::json!({"taskId":"task-1"})).unwrap();
    let _: TaskLaunchAgentParams = serde_json::from_value(serde_json::json!({
        "taskId":"task-1","agentId":"codex",
        "launchTicket":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }))
    .unwrap();
    assert!(validate_method_params(
        "task.previewAgent",
        &serde_json::json!({"taskId":"task-1","agentId":"codex"})
    ));
    assert!(validate_method_params(
        "task.previewAgent",
        &serde_json::json!({
            "taskId":"task-1", "agentId":"codex", "model":"gpt-5.6-sol",
            "permission":"plan", "reasoning":"high"
        })
    ));
    assert!(!validate_method_params(
        "task.previewAgent",
        &serde_json::json!({
            "taskId":"task-1", "agentId":"codex", "model":"gpt-5.6-sol",
            "permission":"unknown", "reasoning":"high"
        })
    ));
    assert!(!validate_method_params(
        "task.launchAgent",
        &serde_json::json!({"taskId":"task-1","agentId":"codex"})
    ));
    let capabilities: AgentCapabilityListResult = serde_json::from_value(serde_json::json!([
        {
            "agent_id":"claude", "label":"Claude", "available":true, "version":"1.2.3",
            "integration_level":"full", "degraded_reason":null,
            "models":["default","sonnet"], "permissions":["default","acceptEdits"],
            "reasoning":["default","high"], "observation_supported":true,
            "quick_action_supported":true, "tracked_helpers_supported":true,
            "resume_supported":true, "native_fork_supported":true
        },
        {
            "agent_id":"codex", "label":"Codex", "available":false, "version":null,
            "integration_level":"launchOnly", "degraded_reason":"cliUnavailable",
            "models":["default"], "permissions":["default"], "reasoning":["default"],
            "observation_supported":false, "quick_action_supported":false,
            "tracked_helpers_supported":false, "resume_supported":false,
            "native_fork_supported":false
        },
        {
            "agent_id":"gemini", "label":"Gemini CLI", "available":true, "version":"0.39.1",
            "integration_level":"launchOnly", "degraded_reason":"observationUnavailable",
            "models":["default","flash"], "permissions":["default","plan"],
            "reasoning":["default"], "observation_supported":false,
            "quick_action_supported":false, "tracked_helpers_supported":false,
            "resume_supported":false, "native_fork_supported":false
        }
    ]))
    .unwrap();
    assert_eq!(capabilities.len(), 3);
}

#[test]
fn project_agent_preview_accepts_a_complete_saved_quick_action_preset() {
    assert!(validate_method_params(
        "session.previewAgent",
        &serde_json::json!({
            "projectId":"project-1", "cwd":"/tmp/project", "agentId":"codex",
            "model":"gpt-5.6-sol", "permission":"plan", "reasoning":"high"
        })
    ));
    assert!(!validate_method_params(
        "session.previewAgent",
        &serde_json::json!({
            "projectId":"project-1", "cwd":"/tmp/project", "agentId":"codex",
            "model":"gpt-5.6-sol", "permission":"unknown", "reasoning":"high"
        })
    ));
}

#[test]
fn task_launch_errors_preserve_typed_details() {
    for value in [
        serde_json::json!({"code":"conflict","message":"opaque","details":{"kind":"worktreeRequired","taskId":"task-1"}}),
        serde_json::json!({"code":"conflict","message":"opaque","details":{"kind":"worktreeUnavailable","taskId":"task-1","reason":"headMismatch"}}),
    ] {
        assert!(serde_json::from_value::<ProtocolError>(value).is_ok());
    }
}
