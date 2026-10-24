//! Shares the server user's own Claude setup with an account's private config
//! folder: Claude reads only `CLAUDE_CONFIG_DIR`, so without this a new
//! account starts without the user's status line, hooks, permissions,
//! commands, skills or memory. Logins and live runtime state never move.

use std::path::Path;

use serde_json::{Map, Value};
use termloop_platform::{
    SharedEntryKind, copy_shared_file, create_private_file, link_shared_directory,
    list_entry_names, read_bounded_file_if_present, shared_entry_kind, write_shared_file,
};

/// What Claude itself leaves out when it seeds a fresh config folder from
/// `~/.claude`: logins, live runtime state, caches and per-folder history.
const UNSHARED_ENTRIES: &[&str] = &[
    "api-dumps",
    "backups",
    "bridge-spawn",
    "cache",
    "ccr",
    "ccr-home-seed.json",
    "chrome",
    "computer-use.lock",
    "debug",
    "downloads",
    "dump-prompts",
    "feedback",
    "feedback-bundles",
    "file-history",
    "file-transfers",
    "gh-pr-status-cache.json",
    "hfi-auth.json",
    "history.jsonl",
    "ide",
    "image-cache",
    "jobs",
    "local",
    "local-settings",
    "logs",
    "loop.md",
    "mcp-discovery-cache",
    "mcp-needs-auth-cache.json",
    "mcp-skill-archives",
    "paste-cache",
    "plans",
    "policy-limits.json",
    "project-settings",
    "projects",
    "remote",
    "remote-control",
    "remote-settings.json",
    "scratch",
    "seed-admin",
    "server-sessions.json",
    "server.lock",
    "session-env",
    "sessions",
    "shares",
    "shell-snapshots",
    "startup-perf",
    "state",
    "stats-cache.json",
    "statsig",
    "storage-v2",
    "systemd",
    "tasks",
    "teams",
    "telemetry",
    "todos",
    "traces",
    "uploads",
    "usage-data",
];

/// `.claude.json` keys bound to one login, which Claude resets on sign-out or
/// writes before any sign-in.
const ACCOUNT_BOUND_STATE: &[&str] = &[
    "oauthAccount",
    "primaryApiKey",
    "userID",
    "machineID",
    "firstStartTime",
    "firstStartVersion",
    "claudeCodeFirstTokenDate",
    "subscriptionNoticeCount",
    "hasAvailableSubscription",
    "additionalModelOptionsAnsweredAt",
    "artifactRosterDenied",
    "lastSeenOrgDefaultUpdatedAt",
    "startupPrefetchedAt",
];

const FILE_LIMIT: usize = 4 * 1024 * 1024;
const STATE_LIMIT: usize = 32 * 1024 * 1024;
const ENTRY_LIMIT: usize = 512;
const MEMORY_IMPORT: &[u8] = b"@~/.claude/CLAUDE.md\n";

fn shared_entry(name: &str) -> bool {
    !name.starts_with('.')
        && !name.starts_with("daemon")
        && !name.starts_with("agent-memory")
        && !UNSHARED_ENTRIES.contains(&name)
}

fn account_bound(key: &str) -> bool {
    ACCOUNT_BOUND_STATE.contains(&key)
        || key.contains("Cache")
        || key.starts_with("cached")
        || key.starts_with("passes")
}

/// Refreshes `profile` from the user's `<home>/.claude`, which stays the
/// master copy: directories are linked, files (including `settings.json`) are
/// copied when they changed, and a new account's `.claude.json` starts from
/// the user's preferences without their login. Best effort per entry; a
/// failure leaves that entry as it was and never blocks a launch.
pub(crate) fn share_user_setup(home: &Path, profile: &Path) {
    let personal = home.join(".claude");
    for name in list_entry_names(&personal, ENTRY_LIMIT).unwrap_or_default() {
        if !shared_entry(&name) {
            continue;
        }
        let (source, target) = (personal.join(&name), profile.join(&name));
        let _ = match shared_entry_kind(&source) {
            Some(SharedEntryKind::Directory) => link_shared_directory(&source, &target),
            // Claude also loads `~/.claude/CLAUDE.md` for projects under home,
            // so the account imports it rather than holding a second copy.
            Some(SharedEntryKind::File) if name == "CLAUDE.md" => {
                write_shared_file(&target, MEMORY_IMPORT, None)
            }
            Some(SharedEntryKind::File) => copy_shared_file(&source, &target, FILE_LIMIT),
            None => continue,
        };
    }
    seed_state(&home.join(".claude.json"), &profile.join(".claude.json"));
}

/// Seeds only an absent file: once Claude owns the account's state, its own
/// writes win and nothing here races them.
fn seed_state(source: &Path, target: &Path) {
    if target.symlink_metadata().is_ok() {
        return;
    }
    let Ok(Some(bytes)) = read_bounded_file_if_present(source, STATE_LIMIT) else {
        return;
    };
    let Ok(Value::Object(state)) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    let shared: Map<String, Value> = state
        .into_iter()
        .filter(|(key, _)| !account_bound(key))
        .collect();
    if let Ok(mut text) = serde_json::to_vec_pretty(&Value::Object(shared)) {
        text.push(b'\n');
        let _ = create_private_file(target, &text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("termloop-claude-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        let profile = root.join("profile");
        fs::create_dir_all(home.join(".claude/commands")).unwrap();
        fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
        fs::create_dir_all(&profile).unwrap();
        (root, home, profile)
    }

    #[test]
    fn a_new_account_gets_the_users_setup_but_never_their_login() {
        let (root, home, profile) = scratch();
        let personal = home.join(".claude");
        let settings =
            r#"{"statusLine":{"type":"command","command":"~/.claude/statusline-command.sh"}}"#;
        fs::write(personal.join("settings.json"), settings).unwrap();
        fs::write(personal.join("statusline-command.sh"), "echo ok").unwrap();
        fs::write(personal.join("CLAUDE.md"), "Be brief.").unwrap();
        fs::write(personal.join(".credentials.json"), "secret").unwrap();
        fs::write(personal.join("history.jsonl"), "{}").unwrap();
        fs::write(
            home.join(".claude.json"),
            r#"{"theme":"dark","hasCompletedOnboarding":true,"oauthAccount":{"emailAddress":"a@b.c"},"userID":"u","cachedGrowthBookFeatures":{}}"#,
        )
        .unwrap();

        share_user_setup(&home, &profile);

        assert_eq!(
            fs::read_to_string(profile.join("settings.json")).unwrap(),
            settings
        );
        assert_eq!(
            fs::read_to_string(profile.join("statusline-command.sh")).unwrap(),
            "echo ok"
        );
        assert_eq!(
            fs::read(profile.join("CLAUDE.md")).unwrap(),
            MEMORY_IMPORT.to_vec()
        );
        assert!(
            fs::symlink_metadata(profile.join("commands"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        for private in [".credentials.json", "history.jsonl", "projects"] {
            assert!(
                fs::symlink_metadata(profile.join(private)).is_err(),
                "{private}"
            );
        }
        let state: Value =
            serde_json::from_slice(&fs::read(profile.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(state["theme"], "dark");
        assert_eq!(state["hasCompletedOnboarding"], true);
        for key in ["oauthAccount", "userID", "cachedGrowthBookFeatures"] {
            assert!(state.get(key).is_none(), "{key}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn later_launches_follow_the_users_settings_and_leave_account_state_alone() {
        let (root, home, profile) = scratch();
        fs::write(home.join(".claude/settings.json"), "{}").unwrap();
        fs::write(home.join(".claude.json"), r#"{"theme":"light"}"#).unwrap();
        fs::write(
            profile.join(".claude.json"),
            r#"{"theme":"dark","oauthAccount":{}}"#,
        )
        .unwrap();
        share_user_setup(&home, &profile);
        fs::write(home.join(".claude/settings.json"), r#"{"model":"opus"}"#).unwrap();
        share_user_setup(&home, &profile);
        assert_eq!(
            fs::read_to_string(profile.join("settings.json")).unwrap(),
            r#"{"model":"opus"}"#
        );
        assert_eq!(
            fs::read_to_string(profile.join(".claude.json")).unwrap(),
            r#"{"theme":"dark","oauthAccount":{}}"#
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_personal_setup_changes_nothing() {
        let root = std::env::temp_dir().join(format!("termloop-claude-{}", uuid::Uuid::new_v4()));
        let profile = root.join("profile");
        fs::create_dir_all(&profile).unwrap();
        share_user_setup(&root.join("home"), &profile);
        assert_eq!(fs::read_dir(&profile).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
}
