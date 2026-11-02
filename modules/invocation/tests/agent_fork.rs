use termloop_domain::{AgentLaunchSelection, ResumeProvider, ResumeRef};
use termloop_invocation::{
    AgentConversationLaunch, InvocationError, agent_fork_notice_template,
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
    for agent in ["codex", "claude"] {
        let source_ref = source_ref(agent);
        let launch = interactive_agent_fork_for_conversation(
            agent,
            "/tmp",
            &selection,
            SOURCE_SESSION_ID,
            AgentConversationLaunch::Fork {
                source_ref: &source_ref,
            },
            None,
            None,
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
        if agent == "codex" {
            assert_eq!(
                launch.codex_app_server_developer_instructions(),
                Some(instructions.as_str())
            );
        } else {
            assert!(
                launch
                    .args()
                    .windows(2)
                    .any(|pair| pair[0] == "--append-system-prompt" && pair[1] == *instructions)
            );
            assert!(launch.args().iter().any(|arg| arg == "--fork-session"));
        }
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
