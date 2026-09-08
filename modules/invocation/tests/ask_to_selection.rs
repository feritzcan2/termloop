use termloop_domain::{AgentLaunchSelection, PersonalAgent};
use termloop_invocation::{
    AgentConversationLaunch, AgentMcpLaunch, AgentMcpProfile, InvocationError,
    ask_to_helper_agent_for_conversation, ask_to_helper_agent_for_managed_worktree_conversation,
    configured_ask_to_helper_for_conversation_resume,
};

fn helper_mcp() -> AgentMcpLaunch<'static> {
    AgentMcpLaunch {
        endpoint: "http://127.0.0.1:4567/mcp",
        token: "private-test-token",
        claude_config_path: "/tmp/claude-mcp.json",
        profile: AgentMcpProfile::Helper,
    }
}

#[test]
fn initial_helper_selection_matches_manifest_and_provider_arguments() {
    for managed in [false, true] {
        for (provider, model, reasoning) in [
            ("codex", "default", "default"),
            ("codex", "gpt-6-astra", "default"),
            ("codex", "default", "high"),
            ("codex", "gpt-6-astra", "max"),
            ("claude", "default", "default"),
            ("claude", "opus", "high"),
        ] {
            let launch_helper = if managed {
                ask_to_helper_agent_for_managed_worktree_conversation
            } else {
                ask_to_helper_agent_for_conversation
            };
            let launch = launch_helper(
                provider,
                "/tmp/project",
                model,
                "default",
                reasoning,
                AgentConversationLaunch::Fresh { resume_ref: None },
                "request-1",
                "Review the change.",
                None,
                helper_mcp(),
                None,
            )
            .unwrap();
            let manifest = launch.inspectable_manifest();
            assert_eq!(manifest.target.model, model);
            assert_eq!(manifest.target.reasoning, reasoning);
            assert_eq!(manifest.target.permission, "default");
            assert_eq!(
                manifest.provenance.template_ref,
                "builtin.agent.ask-to-helper"
            );
            let args = launch.args();
            let model_arg = args.windows(2).find(|pair| pair[0] == "--model");
            if model == "default" {
                assert!(model_arg.is_none());
            } else {
                assert_eq!(model_arg.unwrap()[1], model);
            }
            let reasoning_arg = args.windows(2).find(|pair| {
                pair[0] == "--effort"
                    || (pair[0] == "-c" && pair[1].starts_with("model_reasoning_effort="))
            });
            if reasoning == "default" {
                assert!(reasoning_arg.is_none());
            } else {
                let expected = if provider == "codex" {
                    format!("model_reasoning_effort=\"{reasoning}\"")
                } else {
                    reasoning.to_owned()
                };
                assert_eq!(reasoning_arg.unwrap()[1], expected);
            }
            let delimiter = args.iter().position(|arg| arg == "--").unwrap();
            assert_eq!(args[delimiter + 1], launch.delivered_prompt().unwrap());
            assert!(
                launch
                    .delivered_prompt()
                    .unwrap()
                    .contains("Review the change.")
            );
            assert!(!format!("{manifest:?}").contains("private-test-token"));
        }
    }
}

#[test]
fn helper_selection_rejects_unsupported_provider_settings() {
    for (model, reasoning) in [("opus", "default"), ("gpt-6-astra", "unknown")] {
        let result = ask_to_helper_agent_for_conversation(
            "codex",
            "/tmp/project",
            model,
            "default",
            reasoning,
            AgentConversationLaunch::Fresh { resume_ref: None },
            "request-1",
            "Review the change.",
            None,
            helper_mcp(),
            None,
        );
        assert!(matches!(
            result,
            Err(InvocationError::UnsupportedModel { .. })
                | Err(InvocationError::UnsupportedReasoning { .. })
        ));
    }
}

#[test]
fn helper_launch_applies_and_exposes_the_pinned_agent_profile() {
    let profile = PersonalAgent {
        id: "builtin.agent-profile.edge-case-hunter".into(),
        version: 2,
        name: "Edge Case Hunter".into(),
        description: "Probe boundary conditions and failure paths.".into(),
        category: "Quality".into(),
        instructions: "EDGE-CASE-HUNTER-MARKER: inspect races and failure paths.".into(),
        agent_id: "codex".into(),
        selection: AgentLaunchSelection::new("default", "plan", "high"),
    };
    let launch = ask_to_helper_agent_for_conversation(
        "codex",
        "/tmp/project",
        "default",
        "plan",
        "high",
        AgentConversationLaunch::Fresh { resume_ref: None },
        "request-profiled-review",
        "Review the completed implementation.",
        None,
        helper_mcp(),
        Some(&profile),
    )
    .unwrap();

    assert_eq!(
        launch.provenance().template_ref,
        "builtin.agent.ask-to-helper"
    );
    assert_eq!(launch.inspectable_manifest().target.permission, "plan");
    assert_eq!(launch.inspectable_manifest().target.reasoning, "high");
    assert!(
        launch
            .bindings()
            .any(|binding| binding == ("profileRef", profile.id.as_str()))
    );
    assert!(
        launch
            .inspectable_manifest()
            .content_parts
            .iter()
            .any(|part| {
                part.kind == "providerInstructions"
                    && part.content.contains("EDGE-CASE-HUNTER-MARKER")
            })
    );

    let resume_ref = termloop_domain::ResumeRef::for_provider(
        termloop_domain::ResumeProvider::Codex,
        "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
    )
    .unwrap();
    let resumed = configured_ask_to_helper_for_conversation_resume(
        "codex",
        "/tmp/project",
        "default",
        "plan",
        "high",
        None,
        AgentConversationLaunch::Resume {
            resume_ref: &resume_ref,
        },
        None,
        Some(helper_mcp()),
        Some(&profile),
    )
    .unwrap();
    assert!(
        resumed
            .bindings()
            .any(|binding| binding == ("profileRef", profile.id.as_str()))
    );
    assert!(
        resumed
            .inspectable_manifest()
            .content_parts
            .iter()
            .any(|part| {
                part.kind == "providerInstructions"
                    && part.content.contains("EDGE-CASE-HUNTER-MARKER")
            })
    );
}

#[test]
fn helper_resume_reapplies_the_saved_model_and_reasoning() {
    for (provider, model, reasoning, resume_provider) in [
        (
            "codex",
            "gpt-6-astra",
            "max",
            termloop_domain::ResumeProvider::Codex,
        ),
        (
            "claude",
            "opus",
            "high",
            termloop_domain::ResumeProvider::Claude,
        ),
    ] {
        let resume_ref = termloop_domain::ResumeRef::for_provider(
            resume_provider,
            "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
        )
        .unwrap();
        let launch = configured_ask_to_helper_for_conversation_resume(
            provider,
            "/tmp/project",
            model,
            "default",
            reasoning,
            Some("request-1"),
            AgentConversationLaunch::Resume {
                resume_ref: &resume_ref,
            },
            None,
            Some(helper_mcp()),
            None,
        )
        .unwrap();
        assert_eq!(launch.inspectable_manifest().target.model, model);
        assert_eq!(launch.inspectable_manifest().target.reasoning, reasoning);
        assert_eq!(
            launch.provenance().template_ref,
            "builtin.agent.ask-to-resume"
        );
        assert!(
            launch
                .args()
                .windows(2)
                .any(|pair| pair == ["--model", model])
        );
        let expected_reasoning = if provider == "codex" {
            format!("model_reasoning_effort=\"{reasoning}\"")
        } else {
            reasoning.to_owned()
        };
        assert!(launch.args().contains(&expected_reasoning));
    }
}
