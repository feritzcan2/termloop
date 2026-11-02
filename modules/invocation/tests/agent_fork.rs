use termloop_domain::{AgentLaunchSelection, ResumeProvider, ResumeRef};
use termloop_invocation::{
    AgentConversationLaunch, AgentMcpLaunch, AgentMcpProfile, AgentObservationLaunch,
    AgentObservationLaunchTransport, InvocationError, agent_fork_notice_template,
    interactive_agent_fork_for_conversation,
};

const SOURCE_SESSION_ID: &str = "8c1d9a4e-6f0b-4a8e-9a43-1b2c3d4e5f60";

fn source_ref(agent: &str) -> ResumeRef {
    ResumeRef::for_provider(
        if agent == "codex" {
            ResumeProvider::Codex
        } else {
            ResumeProvider::Claude
        },
        "123e4567-e89b-42d3-a456-426614174000".into(),
    )
    .unwrap()
}

#[test]
fn fork_notice_is_delivered_as_instructions_and_matches_the_preview() {
    let selection = AgentLaunchSelection::new("default", "default", "default");
    let interactive_mcp = || AgentMcpLaunch {
        endpoint: "http://127.0.0.1:4567/mcp",
        token: "private-test-token",
        claude_config_path: "/tmp/claude-mcp.json",
        profile: AgentMcpProfile::Interactive,
    };
    for (agent, with_mcp) in [
        ("codex", false),
        ("claude", false),
        ("codex", true),
        ("claude", true),
    ] {
        let source_ref = source_ref(agent);
        let launch = interactive_agent_fork_for_conversation(
            agent,
            "/tmp",
            &selection,
            SOURCE_SESSION_ID,
            AgentConversationLaunch::Fork {
                source_ref: &source_ref,
            },
            (agent == "claude").then(claude_observation),
            with_mcp.then(interactive_mcp),
            false,
        )
        .unwrap();
        // The fork keeps interactive provenance and never submits a first message.
        assert_eq!(
            launch.provenance().template_ref,
            "builtin.agent.interactive"
        );
        assert!(launch.initial_input_submission().is_none());
        let manifest = launch.inspectable_manifest();
        let part = manifest
            .content_parts
            .iter()
            .find(|part| part.kind == "providerInstructions")
            .unwrap();
        assert_eq!(part.source, "resources/prompts/builtin.agent.fork@1");
        let instructions = &part.content;
        assert!(instructions.contains(&format!("Source Session ID: `{SOURCE_SESSION_ID}`")));
        assert!(!instructions.contains("{{"));
        // Codex takes fresh developer instructions, so the interactive protocol
        // travels with the notice. Claude keeps the source's system prompt,
        // which already carries that protocol, and learns only the notice.
        assert_eq!(
            instructions.starts_with("# Interactive agent launch"),
            with_mcp && agent == "codex",
        );
        if agent == "codex" {
            assert!(
                launch
                    .args()
                    .iter()
                    .filter(|arg| arg.starts_with("developer_instructions="))
                    .count()
                    <= 1
            );
            assert_eq!(
                launch.codex_app_server_developer_instructions(),
                Some(instructions.as_str())
            );
        } else {
            // Claude ignores a new appended system prompt on `--fork-session`,
            // so the notice reaches it only through the SessionStart hook.
            assert!(launch.args().iter().any(|arg| arg == "--fork-session"));
            assert!(
                !launch
                    .args()
                    .iter()
                    .any(|arg| arg == "--append-system-prompt")
            );
            let context = launch
                .environment()
                .entries()
                .find(|(key, _)| *key == "TERMLOOP_SESSION_START_CONTEXT")
                .map(|(_, value)| value.to_string_lossy().into_owned());
            assert_eq!(context.as_deref(), Some(instructions.as_str()));
            assert!(manifest.environment.iter().any(|entry| {
                entry.key == "TERMLOOP_SESSION_START_CONTEXT"
                    && entry.display_value != *instructions
            }));
        }
    }
}

fn claude_observation() -> AgentObservationLaunch<'static> {
    AgentObservationLaunch {
        session_id: "8f3a2b1c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
        endpoint: "http://127.0.0.1:4568/agent-observation",
        token: "private-hook-token",
        transport: AgentObservationLaunchTransport::InlineSettings {
            content: "{}",
            inspectable_content: "{}",
        },
    }
}

#[test]
fn fork_notice_template_is_visible_and_rejects_invalid_source_ids() {
    let template = agent_fork_notice_template();
    assert_eq!(template.id, "builtin.agent.fork");
    assert!(template.authored_body.contains("{{source_session_id}}"));
    let selection = AgentLaunchSelection::new("default", "default", "default");
    let source_ref = source_ref("claude");
    for invalid in ["", "  ", "line\nbreak"] {
        assert!(matches!(
            interactive_agent_fork_for_conversation(
                "claude",
                "/tmp",
                &selection,
                invalid,
                AgentConversationLaunch::Fork {
                    source_ref: &source_ref,
                },
                None,
                None,
                false,
            ),
            Err(InvocationError::InvalidPromptBinding)
        ));
    }
}
