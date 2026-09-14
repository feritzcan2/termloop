use termloop_invocation::{AgentConversationLaunch, ImproverTarget, improver_agent};

#[test]
fn workflow_creator_has_one_visible_draft_only_prompt_for_both_providers() {
    for provider in ["claude", "codex"] {
        let launch = improver_agent(
            provider,
            "/tmp",
            "default",
            "default",
            "default",
            ImproverTarget::WorkflowCreator {
                context: "Türkçe görev; preserve {{context}} literally",
            },
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert_eq!(launch.provenance().template_ref, "builtin.builder.workflow");
        let delivered = launch.delivered_prompt().unwrap();
        for text in [
            "Türkçe görev; preserve {{context}} literally",
            "configuration_version_read",
            "configuration_version_write",
            "explicitly saves",
            "Never introduce bypass permissions",
        ] {
            assert!(delivered.contains(text), "{text}");
        }
        assert!(
            launch
                .inspectable_manifest()
                .content_parts
                .iter()
                .any(|part| part.content == delivered)
        );
    }
}
