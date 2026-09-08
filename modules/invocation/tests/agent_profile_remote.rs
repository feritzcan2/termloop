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
    for profile in agent_profiles() {
        for agent_id in ["codex", "claude"] {
            for permission in ["default", "acceptEdits", "plan", "bypassPermissions"] {
                let launch = profile_quick_action_agent_with_attachments_for_conversation(
                    profile.id,
                    agent_id,
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
                let manifest = launch.inspectable_manifest();
                assert_eq!(manifest.target.permission, permission);
                let instructions = &manifest
                    .content_parts
                    .iter()
                    .find(|part| part.kind == "providerInstructions")
                    .unwrap()
                    .content;
                assert_eq!(instructions, profile.instructions());
                assert!(!instructions.contains("read-only"), "{}", profile.id);
                assert!(
                    !instructions.contains("Do not edit files"),
                    "{}",
                    profile.id
                );
                if agent_id == "codex" {
                    assert_eq!(
                        launch.codex_app_server_developer_instructions(),
                        Some(instructions.as_str())
                    );
                } else {
                    assert!(launch.args().windows(2).any(|pair| pair[0]
                        == "--append-system-prompt"
                        && pair[1] == *instructions));
                }
                if permission == "plan" {
                    let expected = if agent_id == "codex" {
                        ["--sandbox", "read-only"]
                    } else {
                        ["--permission-mode", "plan"]
                    };
                    assert!(launch.args().windows(2).any(|pair| pair == expected));
                } else if permission == "bypassPermissions" {
                    let expected = if agent_id == "codex" {
                        "--dangerously-bypass-approvals-and-sandbox"
                    } else {
                        "--dangerously-skip-permissions"
                    };
                    assert!(launch.args().iter().any(|arg| arg == expected));
                }
            }
        }
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
