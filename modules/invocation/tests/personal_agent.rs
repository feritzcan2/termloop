use termloop_domain::{AgentLaunchSelection, PersonalAgent, ResumeProvider, ResumeRef};
use termloop_invocation::{AgentConversationLaunch, personal_agent_for_conversation};

fn profile() -> PersonalAgent {
    PersonalAgent {
        id: "custom.agent-profile.reviewer".into(),
        version: 3,
        name: "Reviewer".into(),
        description: "Review changes".into(),
        category: "Quality".into(),
        instructions: "İncele; preserve {{instructions}} and {{prompt}} literally.".into(),
        agent_id: "codex".into(),
        selection: AgentLaunchSelection::new("default", "plan", "high"),
    }
}

#[test]
fn personal_agent_preview_equals_provider_delivery_and_resume_keeps_the_role() {
    let profile = profile();
    for agent in ["codex", "claude"] {
        let launch = personal_agent_for_conversation(
            &profile,
            agent,
            "/tmp",
            &profile.selection,
            Some("Inspect this change"),
            &[],
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
            false,
        )
        .unwrap();
        let manifest = launch.inspectable_manifest();
        let instructions = &manifest
            .content_parts
            .iter()
            .find(|part| part.kind == "providerInstructions")
            .unwrap()
            .content;
        assert!(instructions.contains(&profile.instructions));
        assert!(instructions.contains("custom.agent-profile.reviewer · revision 3"));
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
        }
        let resume_ref = ResumeRef::for_provider(
            if agent == "codex" {
                ResumeProvider::Codex
            } else {
                ResumeProvider::Claude
            },
            "123e4567-e89b-42d3-a456-426614174000".into(),
        )
        .unwrap();
        let resumed = personal_agent_for_conversation(
            &profile,
            agent,
            "/tmp",
            &profile.selection,
            None,
            &[],
            AgentConversationLaunch::Resume {
                resume_ref: &resume_ref,
            },
            None,
            None,
            false,
        )
        .unwrap();
        assert!(resumed.initial_input_submission().is_none());
        assert_eq!(resumed.inspectable_manifest().content_parts.len(), 1);
        assert_eq!(
            &resumed.inspectable_manifest().content_parts[0].content,
            instructions
        );
        assert_eq!(resumed.inspectable_manifest().target.permission, "plan");
    }
}

#[test]
fn personal_agent_rejects_invalid_or_oversized_instructions() {
    let mut profile = profile();
    for instructions in [" ".to_owned(), "x".repeat(32769), "😀".repeat(8193)] {
        profile.instructions = instructions;
        assert!(
            personal_agent_for_conversation(
                &profile,
                "codex",
                "/tmp",
                &profile.selection,
                Some("Inspect"),
                &[],
                AgentConversationLaunch::Fresh { resume_ref: None },
                None,
                None,
                false
            )
            .is_err()
        );
    }
}
