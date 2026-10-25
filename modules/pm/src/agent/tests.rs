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
    assert!(
        profile
            .system_prompt
            .contains("When: day 1, no planned end")
    );
    assert!(
        profile
            .system_prompt
            .contains("Tickets: 1, done: 0, with risks: 1, without acceptance criteria: 1")
    );
    let kickoff = profile.first_message.unwrap();
    assert!(kickoff.contains("at most 12 lines"));
    assert!(kickoff.contains(&ticket_id));
    assert!(!kickoff.contains("Let users log in"));
    assert!(!kickoff.contains("delivery check"));
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
        assert_eq!(args.last(), profile.first_message.as_ref(), "{agent}");
        if mode == PmAgentMode::DeliveryCheck {
            assert!(args.last().unwrap().contains(&ticket_id));
        }
    }
    std::fs::remove_dir_all(directory).ok();
}

fn offers(kickoff: &str) -> Vec<&str> {
    kickoff
        .lines()
        .filter_map(|line| line.strip_prefix("- "))
        .collect()
}

#[test]
fn a_code_folder_launch_reads_the_code_but_never_edits_it() {
    let (mut store, ticket_id) = project_store();
    with_environments(&mut store);
    let directory = cli_directory();
    for agent in ["claude", "codex"] {
        let profile =
            PmAgentProfile::build(&store, "p1", PmAgentMode::DeliveryCheck, Some(&ticket_id))
                .unwrap();
        let mut request =
            PmLaunchRequest::new(agent, "/work/shop", &profile, ENDPOINT, TOKEN, CONFIG_PATH);
        request.executable_directory = Some(&directory);
        request.permission = "bypassPermissions";
        request.read_only_workspace = true;
        let args = pm_launch_plan(request).unwrap().payload.args().to_vec();
        match agent {
            "claude" => assert!(
                args.windows(2)
                    .any(|pair| pair == ["--disallowedTools", "Edit,Write,NotebookEdit"]),
                "{args:?}"
            ),
            _ => {
                assert!(
                    args.windows(2)
                        .any(|pair| pair == ["--sandbox", "read-only"])
                );
                assert!(
                    !args
                        .iter()
                        .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox")
                );
            }
        }
    }
    std::fs::remove_dir_all(directory).ok();
}

#[test]
fn the_assistant_kickoff_fits_the_focus_and_the_tier() {
    let (mut store, ticket_id) = project_store();
    let kickoff = |store: &PmStore, focus: Option<&str>| {
        PmAgentProfile::build(store, "p1", PmAgentMode::Assistant, focus)
            .unwrap()
            .first_message
            .unwrap()
    };

    let sprint = kickoff(&store, None);
    let sprint_offers = offers(&sprint);
    assert!(sprint_offers[0].contains("summarise the sprint"));
    assert!(
        sprint_offers
            .iter()
            .all(|offer| !offer.contains("in focus"))
    );
    assert!((3..=6).contains(&sprint_offers.len()), "{sprint_offers:?}");
    assert!(!sprint.contains("delivery check"));
    assert!(sprint.contains("draft the project manager confirms"));
    assert!(sprint.contains("Do not call pm_ticket_propose_description"));

    let focused = kickoff(&store, Some(&ticket_id));
    let focused_offers = offers(&focused);
    assert!(focused_offers[0].contains("description for the ticket in focus"));
    assert!(focused_offers[1].contains("acceptance criteria for the ticket in focus"));
    assert!(focused.contains(&format!("The ticket in focus is {ticket_id}.")));
    assert!(!focused.contains("delivery check"));

    with_environments(&mut store);
    let deploy = kickoff(&store, None);
    assert!(
        offers(&deploy)
            .iter()
            .any(|offer| offer.contains("delivery check"))
    );
    let deploy_focused = kickoff(&store, Some(&ticket_id));
    assert!(
        offers(&deploy_focused)
            .iter()
            .any(|offer| offer.contains("ticket in focus needs a delivery check"))
    );
    assert!(deploy_focused.len() < 2_048);
}

#[test]
fn only_a_fresh_assistant_conversation_gets_the_kickoff() {
    let (mut store, ticket_id) = project_store();
    let profile = PmAgentProfile::build(&store, "p1", PmAgentMode::Assistant, None).unwrap();
    let kickoff = profile.first_message.as_deref().unwrap();
    assert_eq!(launch::first_message(&profile, true), Some(kickoff));
    assert_eq!(launch::first_message(&profile, false), None);

    // A delivery check still refuses anything but a fresh conversation.
    with_environments(&mut store);
    let check =
        PmAgentProfile::build(&store, "p1", PmAgentMode::DeliveryCheck, Some(&ticket_id)).unwrap();
    let directory = cli_directory();
    let mut request =
        PmLaunchRequest::new("claude", "/tmp/pm", &check, ENDPOINT, TOKEN, CONFIG_PATH);
    request.executable_directory = Some(&directory);
    assert!(pm_launch_plan(request).is_ok());
    let without_message = PmAgentProfile {
        first_message: None,
        ..check
    };
    let mut request = PmLaunchRequest::new(
        "claude",
        "/tmp/pm",
        &without_message,
        ENDPOINT,
        TOKEN,
        CONFIG_PATH,
    );
    request.executable_directory = Some(&directory);
    assert!(matches!(
        pm_launch_plan(request),
        Err(PmLaunchError::InvalidDeliveryCheck)
    ));
    // An assistant without a first message still launches.
    let quiet = PmAgentProfile {
        first_message: None,
        ..profile
    };
    let mut request =
        PmLaunchRequest::new("codex", "/tmp/pm", &quiet, ENDPOINT, TOKEN, CONFIG_PATH);
    request.executable_directory = Some(&directory);
    assert!(pm_launch_plan(request).is_ok());
    std::fs::remove_dir_all(directory).ok();
}

#[test]
fn the_sprint_day_counts_whole_days() {
    use super::profile::sprint_day;
    use crate::delivery::risks::DAY_MS;
    let mut store = PmStore::open_in_memory().unwrap();
    let mut sprint = store
        .create_sprint("p1", "S", None, SprintState::Planned)
        .unwrap();
    sprint.activated_at_epoch_ms = Some(10 * DAY_MS);
    sprint.ends_at_epoch_ms = Some(20 * DAY_MS);
    assert_eq!(sprint_day(&sprint, 10 * DAY_MS), "day 1 of 10");
    assert_eq!(sprint_day(&sprint, 14 * DAY_MS + 1), "day 5 of 10");
    assert_eq!(sprint_day(&sprint, 22 * DAY_MS), "over by 2 day(s)");
    sprint.ends_at_epoch_ms = None;
    assert_eq!(sprint_day(&sprint, 12 * DAY_MS), "day 3, no planned end");
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

#[test]
fn the_assistant_hears_the_focus_notes_and_can_start_a_description_update() {
    let (mut store, ticket_id) = project_store();
    store
        .add_ticket_note(crate::NewTicketNote {
            ticket_id: ticket_id.clone(),
            kind: crate::TicketNoteKind::Fact,
            text: "Login also needs SSO".into(),
            url: None,
            source_key: None,
            author: crate::TicketAuthor::Pm,
        })
        .unwrap();
    store
        .add_ticket_note(crate::NewTicketNote {
            ticket_id: ticket_id.clone(),
            kind: crate::TicketNoteKind::Source,
            text: "Slack #login thread".into(),
            url: Some("https://acme.slack.com/archives/C1/p1".into()),
            source_key: None,
            author: crate::TicketAuthor::Pm,
        })
        .unwrap();

    let brief =
        PmAgentProfile::build(&store, "p1", PmAgentMode::Assistant, Some(&ticket_id)).unwrap();
    assert!(brief.system_prompt.contains("(1 pending"));
    assert!(
        brief
            .system_prompt
            .contains("pending fact: Login also needs SSO")
    );
    assert!(
        brief.system_prompt.contains(
            "source to read: Slack #login thread <https://acme.slack.com/archives/C1/p1>"
        )
    );
    assert!(brief.tools.contains(&PM_TICKET_NOTE_ADD));

    let update = PmAgentProfile::build_for(
        &store,
        "p1",
        PmAgentMode::Assistant,
        Some(&ticket_id),
        AssistantTask::UpdateDescription,
    )
    .unwrap();
    let kickoff = update.first_message.unwrap();
    assert!(kickoff.starts_with("Bring the description of the ticket in focus up to date"));
    assert!(kickoff.ends_with(&format!("The ticket in focus is {ticket_id}.")));
    // The kickoff goes in argv: it names the ticket by id, never its text.
    assert!(!kickoff.contains("SSO"));

    for (mode, focus) in [
        (PmAgentMode::Assistant, None),
        (PmAgentMode::SkillCreator, Some(ticket_id.as_str())),
    ] {
        assert!(matches!(
            PmAgentProfile::build_for(&store, "p1", mode, focus, AssistantTask::UpdateDescription),
            Err(PmError::Invalid("task"))
        ));
    }
}
