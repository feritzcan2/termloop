use termloop_domain::{AgentLaunchSelection, ResumeProvider, ResumeRef};
use termloop_invocation::{
    AgentConversationLaunch, AgentMcpLaunch, AgentMcpProfile, playbook_evaluator_for_conversation,
};

#[test]
fn evaluation_forks_apply_selected_model_and_permissions_with_visible_instructions() {
    for (provider, identity) in [
        ("claude", ResumeProvider::Claude),
        ("codex", ResumeProvider::Codex),
    ] {
        for permission in ["plan", "default", "acceptEdits", "bypassPermissions"] {
            let source =
                ResumeRef::for_provider(identity, "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036".into())
                    .unwrap();
            let selection = AgentLaunchSelection {
                model: if provider == "codex" {
                    "gpt-6-luna"
                } else {
                    "haiku"
                }
                .into(),
                permission: permission.into(),
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
            assert_eq!(launch.inspectable_manifest().target.permission, permission);
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
            assert_eq!(launch.inspectable_manifest().target.model, selection.model);
            assert!(
                launch
                    .args()
                    .windows(2)
                    .any(|args| args == ["--model", selection.model.as_str()])
            );
            let bypass_flag = if provider == "codex" {
                "--dangerously-bypass-approvals-and-sandbox"
            } else {
                "--dangerously-skip-permissions"
            };
            assert_eq!(
                launch.args().iter().any(|arg| arg == bypass_flag),
                permission == "bypassPermissions"
            );
            let manifest = format!("{:?}", launch.inspectable_manifest());
            assert!(!manifest.contains("private-test-token"));
            assert!(!manifest.contains("019f1dae-3bf3-73d1-b3c7-08ddbbd1f036"));
        }
    }
}
