use termloop_invocation::{AgentConversationLaunch, ImproverTarget, improver_agent};

#[test]
fn dev_server_improvers_deliver_visible_checkout_isolation_guidance() {
    for provider in ["claude", "codex"] {
        for (target, expected_version) in [
            (
                ImproverTarget::NewRunConfiguration {
                    kind: "devServer",
                    kind_label: "dev server",
                    name: "Dev server",
                },
                6,
            ),
            (
                ImproverTarget::RunConfiguration {
                    configuration_id: "run-7",
                    configuration_name: "Dev server",
                },
                5,
            ),
        ] {
            let template_ref = target.template_ref();
            let launch = improver_agent(
                provider,
                "/tmp/project",
                "default",
                "default",
                "default",
                target,
                AgentConversationLaunch::Fresh { resume_ref: None },
                None,
                None,
            )
            .unwrap();
            assert_eq!(launch.provenance().template_ref, template_ref);
            assert_eq!(launch.provenance().template_version, expected_version);
            let delivered = launch.delivered_prompt().unwrap();
            assert!(delivered.contains(&format!("version: {expected_version}")));
            assert!(!delivered.contains("{{"));
            let normalized = delivered.split_whitespace().collect::<Vec<_>>().join(" ");
            for requirement in [
                "Project checkout and multiple Task worktrees running concurrently",
                "Keep `workingDirectory` relative to the checkout",
                "`TERMLOOP_WORKTREE_PATH` for both Project and Task runs",
                "values are literal; do not assume variable or template expansion",
                "Inspect setup, build, and start scripts",
                "current checkout's sources with checkout-local outputs",
                "Isolate conflicting ports",
                "fallback URLs must reach this run",
                "Do not reuse another checkout's build",
                "or stop another checkout's processes",
                "`oncePerWorktree` setup alone cannot keep builds fresh",
                "Recommend this isolated setup to the user by default",
                "State when simultaneous runs have not been tested",
                "Only after the user says to apply, save, use",
            ] {
                assert!(
                    normalized.contains(requirement),
                    "{provider} {template_ref}: missing {requirement}"
                );
            }
            assert!(
                launch
                    .inspectable_manifest()
                    .content_parts
                    .iter()
                    .any(|part| part.content == delivered)
            );
            assert_eq!(
                launch.initial_input(),
                Some(format!("{delivered}\r").as_str())
            );
        }
    }
}
