use termloop_agents::AgentAccountContext;
use termloop_invocation::{
    AgentConversationLaunch, codex_app_server, configured_interactive_agent_for_conversation,
};

#[test]
fn account_storage_is_part_of_the_inspected_payload_and_codex_app_server() {
    for (agent_id, variable) in [("codex", "CODEX_HOME"), ("claude", "CLAUDE_CONFIG_DIR")] {
        let account = AgentAccountContext {
            agent_id: agent_id.into(),
            account_id: "c3dcf1a0-2548-420c-b662-2a2143a567da".into(),
            name: "Work".into(),
            config_directory: Some(std::env::temp_dir().join("termloop-private-account-path")),
        };
        let conversation = AgentConversationLaunch::Fresh { resume_ref: None };
        let launch = configured_interactive_agent_for_conversation(
            agent_id,
            "/tmp/project",
            "default",
            "default",
            "default",
            conversation.in_account(Some(&account)),
            None,
            None,
        )
        .unwrap();
        let directory = account.config_directory.as_ref().unwrap();
        assert!(
            launch
                .environment()
                .entries()
                .any(|(key, value)| key == variable && value == directory.as_os_str())
        );
        let manifest = launch.inspectable_manifest();
        assert_eq!(
            manifest.target.account_id.as_deref(),
            Some(account.account_id.as_str())
        );
        assert_eq!(manifest.target.account_name.as_deref(), Some("Work"));
        assert!(
            !serde_json::to_string(manifest)
                .unwrap()
                .contains("termloop-private-account-path")
        );
        let mut other = account.clone();
        other.account_id = "0e6bb382-c322-433b-a788-d2c24792e48d".into();
        other.config_directory = Some(std::env::temp_dir().join("termloop-other-account-path"));
        let other_launch = configured_interactive_agent_for_conversation(
            agent_id,
            "/tmp/project",
            "default",
            "default",
            "default",
            conversation.in_account(Some(&other)),
            None,
            None,
        )
        .unwrap();
        assert_ne!(manifest.digest, other_launch.inspectable_manifest().digest);
        if agent_id == "codex" {
            let server = codex_app_server(
                "ws://127.0.0.1:43121",
                "/tmp/project",
                "session",
                None,
                None,
                Some(&account),
            )
            .unwrap();
            for environment in [server.environment(), launch.environment()] {
                assert!(
                    environment
                        .entries()
                        .any(|(key, value)| key == variable && value == directory.as_os_str())
                );
            }
            for args in [server.args(), launch.args()] {
                assert!(
                    args.iter()
                        .any(|arg| arg == "cli_auth_credentials_store=\"file\"")
                );
            }
        }
        let wrong = if agent_id == "codex" {
            "claude"
        } else {
            "codex"
        };
        assert!(
            configured_interactive_agent_for_conversation(
                wrong,
                "/tmp/project",
                "default",
                "default",
                "default",
                conversation.in_account(Some(&account)),
                None,
                None
            )
            .is_err()
        );
    }
}
