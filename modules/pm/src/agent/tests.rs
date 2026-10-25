use std::path::PathBuf;

use super::*;
use crate::{NewTicket, PmError, PmStore, ProjectEnvironment, SprintState};

const ENDPOINT: &str = "http://127.0.0.1:45123/mcp/pm";
const TOKEN: &str = "pm-secret-token-0123456789";
const CONFIG_PATH: &str = "/private/pm/claude-mcp.json";

fn project_store() -> (PmStore, String) {
    let mut store = PmStore::open_in_memory().unwrap();
    let sprint = store
        .create_sprint("p1", "Sprint 7", Some("Ship login"), SprintState::Planned)
        .unwrap();
    store.activate_sprint(&sprint.id).unwrap();
    let ticket = store
        .create_ticket(NewTicket {
            sprint_id: Some(sprint.id),
            description: "## Goal\nLet users log in".into(),
            ..NewTicket::new("p1", "Login")
        })
        .unwrap();
    (store, ticket.id)
}

fn with_environments(store: &mut PmStore) {
    store
        .set_project_environments(
            "p1",
            &[ProjectEnvironment {
                name: "live".into(),
                production: true,
            }],
        )
        .unwrap();
}

fn cli_directory() -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "termloop-pm-launch-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&directory).unwrap();
    for name in ["claude", "codex"] {
        termloop_platform::test_support::write_cli_fixture(
            &directory,
            name,
            "#!/bin/sh\nexit 0\n",
            "@echo off\r\nexit /b 0\r\n",
        )
        .unwrap();
    }
    directory
}

#[test]
fn the_prompt_names_only_the_data_the_project_has() {
    let (mut store, ticket_id) = project_store();
    let profile =
        PmAgentProfile::build(&store, "p1", PmAgentMode::Assistant, Some(&ticket_id)).unwrap();
    assert!(profile.system_prompt.contains("Active sprint: Sprint 7"));
    assert!(profile.system_prompt.contains("Goal: Ship login"));
    assert!(profile.system_prompt.contains("Let users log in"));
    assert!(profile.system_prompt.contains("tickets only"));
    assert!(
        !profile
            .system_prompt
            .contains("Environments in delivery order")
    );
    assert!(profile.first_message.is_none());
    assert_eq!(profile.tools, PmAgentMode::Assistant.tools());

    // A delivery check needs a ticket and deploy tracking.
    assert!(matches!(
        PmAgentProfile::build(&store, "p1", PmAgentMode::DeliveryCheck, None),
        Err(PmError::Invalid("ticketId"))
    ));
    assert!(matches!(
        PmAgentProfile::build(&store, "p1", PmAgentMode::DeliveryCheck, Some(&ticket_id)),
        Err(PmError::Constraint(_))
    ));
    assert!(matches!(
        PmAgentProfile::build(&store, "p2", PmAgentMode::Assistant, Some(&ticket_id)),
        Err(PmError::NotFound)
    ));

    with_environments(&mut store);
    let check =
        PmAgentProfile::build(&store, "p1", PmAgentMode::DeliveryCheck, Some(&ticket_id)).unwrap();
    assert!(check.system_prompt.contains("Mode: delivery check"));
    assert!(
        check
            .system_prompt
            .contains("Environments in delivery order: live")
    );
    assert!(check.first_message.unwrap().contains(&ticket_id));
    assert!(check.tools.contains(&PM_CHECK_REPORT));
}

#[test]
fn the_launch_registers_the_pm_server_and_keeps_the_token_out_of_argv() {
    let (mut store, ticket_id) = project_store();
    with_environments(&mut store);
    let directory = cli_directory();
    for (agent, mode) in [
        ("claude", PmAgentMode::Assistant),
        ("codex", PmAgentMode::Assistant),
        ("claude", PmAgentMode::DeliveryCheck),
        ("codex", PmAgentMode::DeliveryCheck),
    ] {
        let profile = PmAgentProfile::build(&store, "p1", mode, Some(&ticket_id)).unwrap();
        let mut request =
            PmLaunchRequest::new(agent, "/tmp/pm", &profile, ENDPOINT, TOKEN, CONFIG_PATH);
        request.executable_directory = Some(&directory);
        let plan = pm_launch_plan(request).unwrap();
        let args = plan.payload.args();
        assert!(
            !args.iter().any(|arg| arg.contains(TOKEN)),
            "{agent}: {args:?}"
        );
        assert!(!format!("{plan:?}").contains(TOKEN));
        let token = plan
            .payload
            .environment()
            .entries()
            .find(|(key, _)| *key == "TERMLOOP_MCP_TOKEN")
            .map(|(_, value)| value.to_owned());
        assert_eq!(token.as_deref(), Some(std::ffi::OsStr::new(TOKEN)));
        match agent {
            "claude" => {
                let at = args.iter().position(|arg| arg == "--mcp-config").unwrap();
                assert_eq!(args[at + 1], CONFIG_PATH);
                assert!(
                    args.iter()
                        .any(|arg| arg.contains("mcp__termloop_pm__pm_ticket_read"))
                );
            }
            _ => {
                assert!(
                    args.iter()
                        .any(|arg| arg == &format!("mcp_servers.termloop_pm.url=\"{ENDPOINT}\""))
                );
                assert!(
                    args.iter()
                        .any(|arg| arg.contains("termloop_pm.tools.pm_ticket_read"))
                );
            }
        }
        let check_report_approved = args.iter().any(|arg| arg.contains(PM_CHECK_REPORT));
        assert_eq!(
            check_report_approved,
            mode == PmAgentMode::DeliveryCheck,
            "{agent}"
        );
        if mode == PmAgentMode::DeliveryCheck {
            assert!(args.last().unwrap().contains(&ticket_id));
        }
    }
    std::fs::remove_dir_all(directory).ok();
}

#[test]
fn launches_refuse_unsupported_agents_endpoints_and_tokens() {
    let (store, _) = project_store();
    let profile = PmAgentProfile::build(&store, "p1", PmAgentMode::Assistant, None).unwrap();
    let plan = |agent, endpoint, token| {
        pm_launch_plan(PmLaunchRequest::new(
            agent,
            "/tmp/pm",
            &profile,
            endpoint,
            token,
            CONFIG_PATH,
        ))
    };
    assert!(matches!(
        plan("gemini", ENDPOINT, TOKEN),
        Err(PmLaunchError::UnsupportedAgent)
    ));
    for endpoint in [
        "https://127.0.0.1/mcp",
        "http://example.com/mcp",
        "http://127.0.0.1.example.com/mcp",
        "http://user@127.0.0.1/mcp",
    ] {
        assert!(
            matches!(
                plan("claude", endpoint, TOKEN),
                Err(PmLaunchError::InvalidEndpoint)
            ),
            "{endpoint}"
        );
    }
    for token in ["", "has space", "line\nbreak"] {
        assert!(matches!(
            plan("claude", ENDPOINT, token),
            Err(PmLaunchError::InvalidToken)
        ));
    }
    let error = plan("claude", ENDPOINT, TOKEN)
        .err()
        .map(|error| error.to_string());
    assert!(error.is_none_or(|message| !message.contains(TOKEN)));
}

#[test]
fn the_claude_config_reads_the_bearer_from_the_environment() {
    let config: serde_json::Value =
        serde_json::from_str(&claude_mcp_config("http://[::1]:9000/mcp").unwrap()).unwrap();
    let server = &config["mcpServers"]["termloop_pm"];
    assert_eq!(server["type"], "http");
    assert_eq!(server["url"], "http://[::1]:9000/mcp");
    assert_eq!(
        server["headers"]["Authorization"],
        "Bearer ${TERMLOOP_MCP_TOKEN}"
    );
    assert!(claude_mcp_config("http://10.0.0.1/mcp").is_err());
}
