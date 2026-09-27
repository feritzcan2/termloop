use termloop_domain::{AgentLaunchSelection, ResumeProvider, ResumeRef};
use termloop_invocation::{
    AgentConversationLaunch, AgentMcpLaunch, AgentMcpProfile, playbook_evaluator_for_conversation,
};

#[test]
fn evaluation_forks_keep_provider_context_but_have_read_only_permissions_and_visible_instructions()
{
    for (provider, identity) in [
        ("claude", ResumeProvider::Claude),
        ("codex", ResumeProvider::Codex),
    ] {
        let source =
            ResumeRef::for_provider(identity, "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036".into())
                .unwrap();
        let selection = AgentLaunchSelection {
            permission: "bypassPermissions".into(),
            ..Default::default()
        };
        let launch = playbook_evaluator_for_conversation(
            provider,
            "/tmp/task",
            &selection,
            AgentConversationLaunch::Fork {
                source_ref: &source,
            },
            None,
            AgentMcpLaunch {
                endpoint: "http://127.0.0.1:4567/mcp",
                token: "private-test-token",
                claude_config_path: "/tmp/agent-mcp.json",
                profile: AgentMcpProfile::PlaybookEvaluator,
            },
            false,
        )
        .unwrap();
        assert_eq!(
            launch.provenance().template_ref,
            "builtin.agent.playbook-evaluator"
        );
        assert_eq!(launch.provenance().template_version, 2);
        assert_eq!(launch.inspectable_manifest().target.permission, "plan");
        assert_eq!(
            launch.delivered_prompt().unwrap(),
            include_str!("../../../resources/prompts/builtin.agent.playbook-evaluator.md")
        );
        let prompt = launch.delivered_prompt().unwrap();
        assert!(prompt.contains("600 UTF-8 bytes"));
        assert!(prompt.contains("invalidArguments"));
        assert!(prompt.contains("retry the same check"));
        assert!(prompt.contains("Never repeat an accepted report"));
        assert!(launch.args().iter().any(|arg| arg
            == if provider == "claude" {
                "--fork-session"
            } else {
                "fork"
            }));
        assert!(
            !launch
                .args()
                .iter()
                .any(|arg| arg == "--dangerously-skip-permissions"
                    || arg == "--dangerously-bypass-approvals-and-sandbox")
        );
        let manifest = format!("{:?}", launch.inspectable_manifest());
        assert!(!manifest.contains("private-test-token"));
        assert!(!manifest.contains("019f1dae-3bf3-73d1-b3c7-08ddbbd1f036"));
    }
}
