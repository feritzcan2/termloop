//! The tools checklist the Skills panel shows: what the project and this
//! machine have for skills to read through, built from the redacted
//! discovery report. The PM's own sources and the allowlisted CLIs are
//! known here; MCP servers are configured for the agents, not for skills;
//! claude.ai connectors live in the agent's account, so they stay unknown
//! until an agent uses one.

use serde_json::Value;
use termloop_pm::PmError;
use termloop_pm_contract::pm::{PmTool, PmToolKind, PmToolState, PmToolsReadResult};

use crate::app::{AppState, skill_discovery};

pub(crate) async fn read(
    state: &AppState,
    project_id: &str,
    refresh: bool,
) -> Result<PmToolsReadResult, PmError> {
    let report = skill_discovery::discovery(state, project_id, refresh).await?;
    Ok(PmToolsReadResult {
        project_id: project_id.to_owned(),
        tools: checklist(&report),
        read_at_epoch_ms: report["readAtEpochMs"].as_u64().unwrap_or_default(),
    })
}

/// A tool's state and what it means, shared with the skill creator's
/// per-tool check so both say the same about a tool.
pub(crate) type Verdict = (PmToolState, String);

fn verdict(state: PmToolState, detail: impl Into<String>) -> Verdict {
    (state, detail.into())
}

fn jira(jira: &Value) -> Verdict {
    match (
        jira.is_object(),
        jira["credentialStored"] == true,
        jira["boardConfigured"] == true,
    ) {
        (false, _, _) => verdict(
            PmToolState::Missing,
            "Not connected; set it up in Settings.",
        ),
        (true, false, _) => verdict(
            PmToolState::NeedsSetup,
            "No API token is stored; add one in Settings.",
        ),
        (true, true, false) => verdict(
            PmToolState::NeedsSetup,
            "Connected, but no board is chosen.",
        ),
        (true, true, true) => verdict(PmToolState::Ready, "Connected with a board."),
    }
}

pub(crate) fn github(configured: bool, logged_in: bool) -> Verdict {
    match (configured, logged_in) {
        (false, _) => verdict(
            PmToolState::Missing,
            "The code folder has no GitHub remote.",
        ),
        (true, false) => verdict(
            PmToolState::NeedsSetup,
            "The code folder has a GitHub remote, but the GitHub CLI is not logged in.",
        ),
        (true, true) => verdict(
            PmToolState::Ready,
            "The code folder has a GitHub remote and the GitHub CLI is logged in.",
        ),
    }
}

pub(crate) fn code_folder(set: bool) -> Verdict {
    if set {
        verdict(PmToolState::Ready, "Agents read the project's code here.")
    } else {
        verdict(
            PmToolState::Missing,
            "No code folder is set for the project.",
        )
    }
}

/// The project's Playbook: its own once saved, the default steps before.
pub(crate) fn playbook(playbook: &Value) -> Verdict {
    if playbook["saved"] != true {
        return verdict(
            PmToolState::NeedsSetup,
            "The default steps; the Playbook setup reads the repository and proposes the \
             project's own.",
        );
    }
    let steps = playbook["steps"].as_u64().unwrap_or_default();
    let agent_steps = playbook["agentSteps"].as_u64().unwrap_or_default();
    verdict(
        PmToolState::Ready,
        format!("{steps} step(s), {agent_steps} checked by an agent."),
    )
}

/// One allowlisted CLI from its redacted status.
pub(crate) fn cli(status: &Value) -> Verdict {
    let version = status["version"]
        .as_str()
        .map(|version| format!(" {version}"))
        .unwrap_or_default();
    if status["installed"] != true {
        verdict(PmToolState::Missing, "Not installed.")
    } else if status["loggedIn"] == true {
        verdict(
            PmToolState::Ready,
            format!("Installed{version} and logged in."),
        )
    } else {
        verdict(
            PmToolState::NeedsSetup,
            format!("Installed{version}, not logged in."),
        )
    }
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

pub(crate) fn checklist(report: &Value) -> Vec<PmTool> {
    let pm = &report["pm"];
    let clis = array(&report["clis"]);
    let gh_logged_in = clis
        .iter()
        .any(|cli| cli["name"] == "gh" && cli["loggedIn"] == true);
    let sources = [
        ("Jira", jira(&pm["jira"])),
        ("GitHub", github(pm["github"].is_object(), gh_logged_in)),
        ("Code folder", code_folder(pm["checkoutFolder"] == true)),
        ("Playbook", playbook(&pm["playbook"])),
    ]
    .into_iter()
    .map(|(name, verdict)| (PmToolKind::Source, name.to_owned(), verdict));
    let clis = clis.iter().filter_map(|status| {
        Some((
            PmToolKind::Cli,
            status["name"].as_str()?.to_owned(),
            cli(status),
        ))
    });
    let servers = array(&report["mcpServers"]).iter().filter_map(|server| {
        let origin = match server["origin"].as_str() {
            Some("codex") => "Codex",
            Some("project") => "this project's .mcp.json",
            _ => "Claude",
        };
        let detail =
            format!("Configured for {origin}; agents can ask to use it, skill runs cannot.");
        Some((
            PmToolKind::Mcp,
            server["name"].as_str()?.to_owned(),
            verdict(PmToolState::Ready, detail),
        ))
    });
    let connectors = array(&report["accountConnectors"]).iter().filter_map(|name| {
        let detail = "Connected to your Claude account before; only an agent run shows whether it works now.";
        Some((PmToolKind::Connector, name.as_str()?.to_owned(), verdict(PmToolState::Unknown, detail)))
    });
    sources
        .chain(clis)
        .chain(servers)
        .chain(connectors)
        .map(|(kind, name, (state, detail))| PmTool {
            kind,
            name,
            state,
            detail,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn states(tools: &[PmTool]) -> Vec<(&str, PmToolState)> {
        tools
            .iter()
            .map(|tool| (tool.name.as_str(), tool.state.clone()))
            .collect()
    }

    #[test]
    fn the_checklist_reads_sources_clis_servers_and_connectors() {
        let report = json!({
            "pm": {
                "jira": { "site": "acme.atlassian.net", "boardConfigured": true, "credentialStored": false },
                "github": { "repository": "acme/app" },
                "playbook": { "saved": true, "steps": 5, "agentSteps": 2 },
                "checkoutFolder": true,
            },
            "clis": [
                { "name": "gh", "installed": true, "version": "2.62.0", "loggedIn": false },
                { "name": "az", "installed": true, "version": "2.70.0", "loggedIn": true },
                { "name": "aws", "installed": false, "version": null, "loggedIn": false },
            ],
            "mcpServers": [{ "name": "linear", "transport": "stdio", "origin": "codex" }],
            "accountConnectors": ["Slack"],
            "readAtEpochMs": 5,
        });
        let tools = checklist(&report);
        assert_eq!(
            states(&tools),
            [
                ("Jira", PmToolState::NeedsSetup),
                ("GitHub", PmToolState::NeedsSetup),
                ("Code folder", PmToolState::Ready),
                ("Playbook", PmToolState::Ready),
                ("gh", PmToolState::NeedsSetup),
                ("az", PmToolState::Ready),
                ("aws", PmToolState::Missing),
                ("linear", PmToolState::Ready),
                ("Slack", PmToolState::Unknown),
            ]
        );
        assert_eq!(tools[3].detail, "5 step(s), 2 checked by an agent.");
        assert_eq!(tools[5].detail, "Installed 2.70.0 and logged in.");
        assert_eq!(
            tools[7].detail,
            "Configured for Codex; agents can ask to use it, skill runs cannot."
        );
        assert_eq!(tools[8].kind, PmToolKind::Connector);
    }

    #[test]
    fn an_empty_project_lists_its_sources_as_missing() {
        let tools = checklist(&json!({ "pm": { "jira": null, "github": null } }));
        assert_eq!(
            states(&tools),
            [
                ("Jira", PmToolState::Missing),
                ("GitHub", PmToolState::Missing),
                ("Code folder", PmToolState::Missing),
                ("Playbook", PmToolState::NeedsSetup),
            ]
        );
    }
}
