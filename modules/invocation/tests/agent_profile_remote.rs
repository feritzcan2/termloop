use termloop_invocation::{
    AgentConversationLaunch, AgentMcpLaunch, AgentMcpProfile, agent_profiles, codex_app_server,
    profile_quick_action_agent_with_attachments_for_conversation,
};

fn interactive_mcp() -> AgentMcpLaunch<'static> {
    AgentMcpLaunch {
        endpoint: "http://127.0.0.1:4567/mcp",
        token: "private-test-token",
        claude_config_path: "/tmp/claude-mcp.json",
        profile: AgentMcpProfile::Interactive,
    }
}

#[test]
fn profile_permissions_remain_user_selected() {
    let profile = agent_profiles()[0];
    for permission in ["default", "acceptEdits", "plan", "bypassPermissions"] {
        let launch = profile_quick_action_agent_with_attachments_for_conversation(
            profile.id,
            "codex",
            "/tmp/project",
            "default",
            permission,
            "default",
            "Inspect this workflow",
            &[],
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert_eq!(launch.inspectable_manifest().target.permission, permission);
    }
}

#[test]
fn gpt_6_astra_is_forwarded_as_the_selected_codex_model() {
    let profile = agent_profiles()[0];
    let launch = profile_quick_action_agent_with_attachments_for_conversation(
        profile.id,
        "codex",
        "/tmp/project",
        "gpt-6-astra",
        "default",
        "max",
        "Inspect this workflow",
        &[],
        AgentConversationLaunch::Fresh { resume_ref: None },
        None,
        None,
    )
    .unwrap();

    assert_eq!(launch.inspectable_manifest().target.model, "gpt-6-astra");
    assert!(
        launch
            .args()
            .windows(2)
            .any(|arguments| arguments == ["--model", "gpt-6-astra"])
    );
}

#[test]
fn profile_instructions_configure_the_remote_codex_app_server() {
    let profile = agent_profiles()[0];
    let launch = profile_quick_action_agent_with_attachments_for_conversation(
        profile.id,
        "codex",
        "/tmp/project",
        "default",
        "plan",
        "default",
        "Inspect this workflow",
        &[],
        AgentConversationLaunch::Fresh { resume_ref: None },
        None,
        Some(interactive_mcp()),
    )
    .unwrap();
    let instructions = launch
        .codex_app_server_developer_instructions()
        .expect("profile launch carries model-visible Codex instructions");
    assert!(instructions.contains("Interactive agent launch"));
    assert!(instructions.contains(profile.id));

    let app_server = codex_app_server(
        "ws://127.0.0.1:4567",
        "/tmp/project",
        "profile-session",
        Some(interactive_mcp()),
        Some(instructions),
        None,
    )
    .unwrap();
    let developer_instructions = app_server
        .args()
        .windows(2)
        .filter(|arguments| {
            arguments[0] == "-c" && arguments[1].starts_with("developer_instructions=")
        })
        .collect::<Vec<_>>();
    assert_eq!(developer_instructions.len(), 1);
    assert!(developer_instructions[0][1].contains(profile.id));
}
