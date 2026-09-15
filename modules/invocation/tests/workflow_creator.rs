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
        assert_eq!(launch.provenance().template_version, 2);
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

#[test]
fn workflow_creator_onboards_before_asking_and_preserves_contextual_guidance() {
    let contexts = [
        r#"{"project":"First project","task":null,"editorDraft":null,"savedTemplates":[]}"#,
        r#"{"project":"Existing project","task":null,"editorDraft":null,"savedTemplates":[{"name":"Team flow","steps":[{"kind":"implement","title":"Implement"}]}]}"#,
        r#"{"project":"Task project","task":{"title":"Fix reconnect","brief":"Bağlantıyı düzelt"},"editorDraft":null,"savedTemplates":[]}"#,
    ];
    for provider in ["claude", "codex"] {
        for context in contexts {
            let launch = improver_agent(
                provider,
                "/tmp",
                "default",
                "default",
                "default",
                ImproverTarget::WorkflowCreator { context },
                AgentConversationLaunch::Fresh { resume_ref: None },
                None,
                None,
            )
            .unwrap();
            let delivered = launch.delivered_prompt().unwrap();
            let welcome_start = delivered.find("## First reply:").unwrap();
            let welcome_end = delivered.find("## Draft-only authority").unwrap();
            let welcome = &delivered[welcome_start..welcome_end];
            for requirement in [
                "orient them before asking for a goal, even when saved templates exist",
                "workflow is a reusable recipe",
                "The user does not need to know the settings first",
                "Quick implementation:",
                "Implementation + independent review:",
                "Discuss first:",
                "Nothing runs automatically",
                "Do not expose JSON, internal IDs, MCP tools, or the raw context",
                "End with one easy next step",
                "recommend implementation + one independent review",
                "instead of asking them to repeat it",
                "do not repeat the onboarding on every turn",
            ] {
                assert!(welcome.contains(requirement), "{provider}: {requirement}");
            }
            let context_start = delivered.find("## Project and editor context").unwrap();
            assert!(welcome_end < context_start);
            assert_eq!(delivered[context_start..].lines().last(), Some(context));
            assert!(
                launch
                    .inspectable_manifest()
                    .content_parts
                    .iter()
                    .any(|part| part.content == delivered)
            );
        }
    }
}
