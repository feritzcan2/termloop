use termloop_invocation::{AgentConversationLaunch, ImproverTarget, improver_agent};

#[test]
fn creator_instructions_are_visible_and_match_both_provider_deliveries() {
    for provider in ["claude", "codex"] {
        let launch = improver_agent(
            provider,
            "/tmp",
            "default",
            "acceptEdits",
            "high",
            ImproverTarget::AgentCreator {
                project_name: "Demo",
            },
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert_eq!(launch.provenance().template_ref, "builtin.builder.agent");
        let delivered = launch.delivered_prompt().unwrap();
        assert!(delivered.contains("Demo"));
        assert!(delivered.contains("agent_library_read"));
        assert!(delivered.contains("agent_profile_create"));
        assert!(!delivered.contains("configuration_version_write"));
        assert!(delivered.contains("When the user asks to create or save it"));
        assert!(
            launch
                .inspectable_manifest()
                .content_parts
                .iter()
                .any(|part| part.content == delivered)
        );
    }
}
