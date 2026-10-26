//! What the skill creator may learn about a project and this machine. The
//! daemon reads it and redacts before anything reaches the agent or the
//! cache: PM sources as names, hosts, and booleans; allowlisted CLIs as
//! installed, version number, and logged in (exit status only, output
//! discarded); configured MCP servers as name and transport only; the
//! claude.ai connectors Claude Code has connected as names only. Commands,
//! arguments, URLs, environment, headers, tokens, and account names never
//! leave this module.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use termloop_platform::{CommandRequest, CommandTermination};
use termloop_pm::agent::SKILL_READ_TOOLS;
use termloop_pm::{PmError, PmStore};

use crate::app::AppState;

/// The command-line tools discovery and verification may run, each with
/// fixed argv only: its version, and a read-only login check that never
/// prints a secret. Only the check's exit status counts (and, where the
/// tool exits 0 either way, whether it printed anything); its output is
/// discarded.
pub(crate) const CLI_ALLOWLIST: &[(&str, &[&str])] = &[
    ("gh", &["auth", "status"]),
    ("glab", &["auth", "status"]),
    ("az", &["account", "show", "--output", "none"]),
    ("aws", &["sts", "get-caller-identity", "--output", "text"]),
    (
        "gcloud",
        &[
            "auth",
            "list",
            "--filter=status:ACTIVE",
            "--format=value(account)",
        ],
    ),
    ("kubectl", &["config", "current-context"]),
    ("slack", &["auth", "list"]),
];
const CLI_TIMEOUT: Duration = Duration::from_secs(5);
const CLI_OUTPUT_LIMIT: usize = 4 * 1024;
/// A cached report is used for this long unless the sources changed.
pub(crate) const DISCOVERY_FRESH_MS: u64 = 60 * 60 * 1000;
const CONFIG_MAX_BYTES: usize = 1024 * 1024;
const MCP_SERVERS_MAX: usize = 32;
const MCP_NAME_MAX_BYTES: usize = 64;
const VERSION_MAX_BYTES: usize = 32;
const CONNECTOR_PREFIX: &str = "claude.ai ";

/// The project's own sources and tier: no credential, only whether one is
/// stored.
pub(crate) fn pm_sources(store: &PmStore, project_id: &str) -> Result<Value, PmError> {
    let sources = store.project_sources(project_id)?;
    let board = store.board(project_id)?;
    let approved_probes = board
        .probes
        .iter()
        .filter(|probe| probe.status == termloop_pm::ProbeStatus::Approved)
        .count();
    Ok(json!({
        "tier": board.tracking.tier,
        "jira": sources.jira.as_ref().map(|jira| json!({
            "site": host(&jira.site_url),
            "boardConfigured": jira.board_id.is_some(),
            "credentialStored": !jira.credential_handle.is_empty(),
        })),
        "github": sources.github.as_ref().map(|github| json!({ "repository": github.label() })),
        "azureDevOps": sources.azure_devops.as_ref().map(|azure| json!({ "repository": azure.label() })),
        "environments": board.environments.iter().map(|environment| &environment.name).collect::<Vec<_>>(),
        "approvedProbes": approved_probes,
        "checkoutFolder": store.project(project_id)?.and_then(|project| project.folder).is_some(),
    }))
}

/// A URL's host, without user info, path, or query.
fn host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The fingerprint of what discovery depends on; a change invalidates the
/// cache.
pub(crate) fn sources_key(pm: &Value) -> String {
    Sha256::digest(pm.to_string())
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The first `digits.digits[.digits]` in a version output.
pub(crate) fn version_number(output: &str) -> Option<String> {
    output
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .find(|token| {
            let parts: Vec<&str> = token.split('.').collect();
            parts.len() >= 2 && parts.iter().all(|part| !part.is_empty())
        })
        .map(|token| token.chars().take(VERSION_MAX_BYTES).collect())
}

/// Runs an allowlisted CLI by name, looked up on PATH like a probe, so a
/// script wrapper (Homebrew's `az`, `gcloud`) counts as installed. `None`
/// when it could not start.
fn run_fixed(program: &str, args: &[&str]) -> Option<(bool, Vec<u8>)> {
    let request = CommandRequest::new(program)
        .args(args)
        .timeout(CLI_TIMEOUT)
        .output_limit(CLI_OUTPUT_LIMIT);
    let outcome = termloop_platform::run_command(request).ok()?;
    let succeeded = matches!(outcome.termination, CommandTermination::Exited { code: 0 });
    Some((succeeded, outcome.stdout))
}

/// One allowlisted CLI: installed, its version number, and whether its
/// read-only login check succeeds. A name off the allowlist is refused.
pub(crate) fn cli_status(name: &str) -> Option<Value> {
    let (name, login) = CLI_ALLOWLIST
        .iter()
        .copied()
        .find(|(allowed, _)| *allowed == name)?;
    let Some((_, stdout)) = run_fixed(name, &["--version"]) else {
        return Some(
            json!({ "name": name, "installed": false, "version": null, "loggedIn": false }),
        );
    };
    let version = version_number(&String::from_utf8_lossy(&stdout));
    let logged_in = run_fixed(name, login).is_some_and(|(succeeded, stdout)| {
        succeeded && (name != "gcloud" || stdout.iter().any(|byte| !byte.is_ascii_whitespace()))
    });
    Some(json!({
        "name": name,
        "installed": true,
        "version": version,
        "loggedIn": logged_in,
    }))
}

fn read_bounded(path: &Path) -> Option<String> {
    let bytes = termloop_platform::read_bounded_file_if_present(path, CONFIG_MAX_BYTES).ok()??;
    String::from_utf8(bytes).ok()
}

/// A server or connector name safe to report; connector names may hold
/// spaces.
fn valid_name(name: &str, spaces: bool) -> bool {
    !name.is_empty()
        && name.len() <= MCP_NAME_MAX_BYTES
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'_' | b'-' | b'.')
                || (spaces && byte == b' ')
        })
}

/// The transport of one JSON server entry, from its shape only.
fn json_transport(entry: &Value) -> &'static str {
    match entry.get("type").and_then(Value::as_str) {
        Some("http") | Some("streamable-http") => "http",
        Some("sse") => "sse",
        Some("stdio") => "stdio",
        _ if entry.get("url").is_some() => "http",
        _ => "stdio",
    }
}

fn push_server(servers: &mut Vec<Value>, name: &str, transport: &str, origin: &str) {
    if servers.len() < MCP_SERVERS_MAX
        && valid_name(name, false)
        && !servers
            .iter()
            .any(|server| server["name"] == name && server["origin"] == origin)
    {
        servers.push(json!({ "name": name, "transport": transport, "origin": origin }));
    }
}

fn json_servers(servers: &mut Vec<Value>, map: Option<&Value>, origin: &str) {
    if let Some(Value::Object(entries)) = map {
        for (name, entry) in entries {
            push_server(servers, name, json_transport(entry), origin);
        }
    }
}

/// `~/.claude.json`, read once per discovery for its servers and
/// connectors.
pub(crate) fn claude_config(home: Option<&Path>) -> Option<Value> {
    home.and_then(|home| read_bounded(&home.join(".claude.json")))
        .and_then(|text| serde_json::from_str(&text).ok())
}

/// The MCP servers Claude and Codex would load for the project: names and
/// transports from `~/.claude.json` (user and this project's entries), the
/// project's `.mcp.json`, and `~/.codex/config.toml`.
pub(crate) fn mcp_servers(
    home: Option<&Path>,
    claude: Option<&Value>,
    folder: Option<&Path>,
) -> Vec<Value> {
    let mut servers = Vec::new();
    if let Some(home) = home {
        if let Some(claude) = claude {
            json_servers(&mut servers, claude.get("mcpServers"), "claude");
            if let Some(folder) = folder.and_then(Path::to_str) {
                json_servers(
                    &mut servers,
                    claude
                        .get("projects")
                        .and_then(|projects| projects.get(folder))
                        .and_then(|project| project.get("mcpServers")),
                    "claude",
                );
            }
        }
        if let Some(codex) = read_bounded(&home.join(".codex").join("config.toml")) {
            for (name, transport) in codex_servers(&codex) {
                push_server(&mut servers, &name, transport, "codex");
            }
        }
    }
    if let Some(project) = folder
        .and_then(|folder| read_bounded(&folder.join(".mcp.json")))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    {
        json_servers(&mut servers, project.get("mcpServers"), "project");
    }
    servers
}

/// `[mcp_servers.<name>]` tables of a Codex config: a `url` key means
/// HTTP, otherwise stdio. Only table headers and key names are read.
pub(crate) fn codex_servers(toml: &str) -> Vec<(String, &'static str)> {
    let mut servers: Vec<(String, &'static str)> = Vec::new();
    let mut current: Option<usize> = None;
    for line in toml.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[') {
            current = None;
            let header = header.trim_end_matches(']').trim();
            if let Some(name) = header.strip_prefix("mcp_servers.")
                && !name.contains('.')
            {
                let name = name.trim_matches('"');
                servers.push((name.to_owned(), "stdio"));
                current = Some(servers.len() - 1);
            }
        } else if let Some(index) = current
            && line
                .split('=')
                .next()
                .is_some_and(|key| key.trim() == "url")
        {
            servers[index].1 = "http";
        }
    }
    servers
}

/// The claude.ai connectors Claude Code has connected for this user, from
/// `~/.claude.json`: names only. Connected once is not proof they work
/// now; only an agent run can tell.
pub(crate) fn account_connectors(claude: Option<&Value>) -> Vec<String> {
    let mut connectors: Vec<String> = Vec::new();
    for name in claude
        .and_then(|claude| claude.get("claudeAiMcpEverConnected"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|name| name.strip_prefix(CONNECTOR_PREFIX))
    {
        if valid_name(name, true)
            && connectors.len() < MCP_SERVERS_MAX
            && !connectors.iter().any(|known| known == name)
        {
            connectors.push(name.to_owned());
        }
    }
    connectors
}

fn home_and_folder(state: &AppState, project_id: &str) -> (Option<PathBuf>, Option<PathBuf>) {
    let folder = state
        .store
        .lock()
        .project(project_id)
        .ok()
        .flatten()
        .and_then(|project| project.folder)
        .map(PathBuf::from);
    (termloop_platform::user_home_directory(), folder)
}

/// The creator's discovery report for a project: the cached one while it
/// is fresh and its sources are unchanged, otherwise read again and cached.
pub(crate) async fn discovery(
    state: &AppState,
    project_id: &str,
    refresh: bool,
) -> Result<Value, PmError> {
    let pm = pm_sources(&state.store.lock(), project_id)?;
    let key = sources_key(&pm);
    let now = termloop_platform::current_epoch_ms();
    if !refresh
        && let Some((cached, cached_key, at)) = state.store.lock().skill_discovery(project_id)?
        && cached_key == key
        && at.saturating_add(DISCOVERY_FRESH_MS) > now
    {
        return Ok(cached);
    }
    let (home, folder) = home_and_folder(state, project_id);
    let local = tokio::task::spawn_blocking(move || {
        // Each CLI check may wait out its timeout; run them side by side.
        let clis: Vec<Value> = std::thread::scope(|scope| {
            let checks: Vec<_> = CLI_ALLOWLIST
                .iter()
                .map(|(name, _)| scope.spawn(move || cli_status(name)))
                .collect();
            checks
                .into_iter()
                .filter_map(|check| check.join().ok().flatten())
                .collect()
        });
        let claude = claude_config(home.as_deref());
        (
            clis,
            mcp_servers(home.as_deref(), claude.as_ref(), folder.as_deref()),
            account_connectors(claude.as_ref()),
        )
    })
    .await
    .map_err(|_| PmError::Storage("discovery did not finish".to_owned()))?;
    let report = json!({
        "pm": pm,
        "pmReadTools": SKILL_READ_TOOLS,
        "clis": local.0,
        "mcpServers": local.1,
        "accountConnectors": local.2,
        "readAtEpochMs": now,
        "note": "Skill runs read only through the PM's own tools; a CLI or MCP server listed \
                 here is a hint for what the project manager could connect, never something a \
                 skill calls. accountConnectors were connected to the user's Claude account at \
                 some point; whether they work now only your own tool list shows.",
    });
    state
        .store
        .lock()
        .cache_skill_discovery(project_id, &report, &key)?;
    Ok(report)
}

/// The MCP server names discovery reports for the project.
pub(crate) fn configured_server(state: &AppState, project_id: &str, name: &str) -> bool {
    let (home, folder) = home_and_folder(state, project_id);
    let claude = claude_config(home.as_deref());
    mcp_servers(home.as_deref(), claude.as_ref(), folder.as_deref())
        .iter()
        .any(|server| server["name"] == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRETS: &[&str] = &[
        "sk-secret-token",
        "Bearer abc123",
        "/usr/local/bin/secret-server",
        "--api-key",
        "hunter2",
        "mcp.example.com",
    ];

    #[test]
    fn mcp_servers_report_name_transport_and_origin_only() {
        let root = std::env::temp_dir().join(format!("pm-discovery-{}", uuid::Uuid::new_v4()));
        let (home, folder) = (root.join("home"), root.join("project"));
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(&folder).unwrap();
        let folder_key = folder.to_str().unwrap();
        std::fs::write(
            home.join(".claude.json"),
            json!({
                "mcpServers": {
                    "linear": {
                        "command": "/usr/local/bin/secret-server",
                        "args": ["--api-key", "hunter2"],
                        "env": { "TOKEN": "sk-secret-token" },
                    },
                    "remote": {
                        "type": "http",
                        "url": "https://mcp.example.com/?token=sk-secret-token",
                        "headers": { "Authorization": "Bearer abc123" },
                    },
                    "bad name; rm -rf": { "command": "x" },
                },
                "projects": { folder_key: { "mcpServers": { "sentry": { "type": "sse", "url": "https://mcp.example.com" } } } },
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            home.join(".codex").join("config.toml"),
            "[mcp_servers.github]\ncommand = \"/usr/local/bin/secret-server\"\n\
             [mcp_servers.github.env]\nGITHUB_TOKEN = \"sk-secret-token\"\n\
             [mcp_servers.docs]\nurl = \"https://mcp.example.com\"\n",
        )
        .unwrap();
        std::fs::write(
            folder.join(".mcp.json"),
            json!({ "mcpServers": { "local": { "command": "hunter2" } } }).to_string(),
        )
        .unwrap();

        let claude = claude_config(Some(&home));
        let servers = mcp_servers(Some(&home), claude.as_ref(), Some(&folder));
        let _ = std::fs::remove_dir_all(&root);
        let text = serde_json::to_string(&servers).unwrap();
        for secret in SECRETS {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        let named: Vec<(&str, &str, &str)> = servers
            .iter()
            .map(|server| {
                (
                    server["name"].as_str().unwrap(),
                    server["transport"].as_str().unwrap(),
                    server["origin"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            named,
            [
                ("linear", "stdio", "claude"),
                ("remote", "http", "claude"),
                ("sentry", "sse", "claude"),
                ("github", "stdio", "codex"),
                ("docs", "http", "codex"),
                ("local", "stdio", "project"),
            ]
        );
        for server in &servers {
            assert_eq!(server.as_object().unwrap().len(), 3);
        }
    }

    #[test]
    fn account_connectors_are_claude_ai_names_only() {
        let home = std::env::temp_dir().join(format!("pm-connectors-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join(".claude.json"),
            json!({
                "claudeAiMcpEverConnected": [
                    "claude.ai Slack",
                    "claude.ai Atlassian Rovo",
                    "claude.ai Slack",
                    "plugin:cloudflare:cloudflare",
                    "claude.ai bad;name",
                    "claude.ai ",
                ],
                "oauthAccount": { "emailAddress": "me@example.com" },
            })
            .to_string(),
        )
        .unwrap();
        let connectors = account_connectors(claude_config(Some(&home)).as_ref());
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(connectors, ["Slack", "Atlassian Rovo"]);
        assert!(account_connectors(None).is_empty());
    }

    #[test]
    fn a_site_is_reported_as_its_host_only() {
        assert_eq!(
            host("https://me:sk-secret-token@Acme.atlassian.net/jira?token=x").as_deref(),
            Some("acme.atlassian.net")
        );
        assert_eq!(host("not a url"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_script_wrapper_runs_like_a_native_cli() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("pm-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("az");
        std::fs::write(&script, "#!/bin/sh\necho \"azure-cli 2.87.0\"\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let ran = run_fixed(script.to_str().unwrap(), &["--version"]);
        let missing = run_fixed(root.join("missing").to_str().unwrap(), &["--version"]);
        let _ = std::fs::remove_dir_all(&root);
        let (succeeded, stdout) = ran.expect("a script wrapper starts");
        assert!(succeeded);
        assert_eq!(
            version_number(&String::from_utf8_lossy(&stdout)).as_deref(),
            Some("2.87.0")
        );
        assert!(missing.is_none());
    }

    #[test]
    fn a_cli_off_the_allowlist_is_never_run() {
        assert!(cli_status("rm").is_none());
        assert!(cli_status("sh").is_none());
        assert!(CLI_ALLOWLIST.iter().all(|(name, login)| {
            !login.iter().any(|argument| argument.contains("token"))
                && name.bytes().all(|byte| byte.is_ascii_lowercase())
        }));
    }

    #[test]
    fn a_version_is_its_number_only() {
        assert_eq!(
            version_number("gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli").as_deref(),
            Some("2.62.0")
        );
        assert_eq!(
            version_number("aws-cli/2.15.1 Python/3.11.6").as_deref(),
            Some("2.15.1")
        );
        assert_eq!(version_number("no version here"), None);
    }
}
