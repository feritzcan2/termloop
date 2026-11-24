//! Per-owner `gh` account routing.
//!
//! `gh` answers with whichever account is active, so a repository that only a
//! second logged-in account can see (a work organization next to a personal
//! account) reads as "not found" the moment the user switches accounts. When a
//! request against an owner comes back not visible, the client asks `gh` which
//! accounts are logged in and retries with each other account's token. The
//! first account that can see the repository is pinned to that owner in memory
//! and used for later requests, regardless of which account is active.
//!
//! Tokens stay in daemon memory as opaque secrets and reach `gh` only through
//! the child's `GH_TOKEN` environment; they are never logged or persisted.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::Value;
use termloop_platform::{
    CommandOutcome, CommandRequest, CommandTermination, MonotonicDeadline, SecureSecret,
};

use super::{GITHUB_HOST, GitHubClient, ProviderFailure, valid_github_login};

/// How long after a probe an owner is not probed again, so a repository that no
/// logged-in account can see costs one extra round of `gh` calls per window.
const PROBE_COOLDOWN: Duration = Duration::from_secs(5 * 60);
const MAX_ROUTED_OWNERS: usize = 256;
const MAX_TOKEN_BYTES: usize = 512;
const ACCOUNT_LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub(crate) struct PinnedAccount {
    login: String,
    token: Arc<SecureSecret>,
}

#[derive(Default)]
struct OwnerRoute {
    pinned: Option<PinnedAccount>,
    next_probe: Option<MonotonicDeadline>,
}

#[derive(Clone, Default)]
pub(crate) struct GitHubAccountRouter {
    owners: Arc<Mutex<BTreeMap<String, OwnerRoute>>>,
}

impl GitHubAccountRouter {
    fn owners(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, OwnerRoute>> {
        self.owners.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn pinned(&self, owner: &str) -> Option<PinnedAccount> {
        self.owners()
            .get(&owner.to_ascii_lowercase())
            .and_then(|route| route.pinned.clone())
    }

    /// Claims the probe slot for `owner`; false while a recent probe cools down.
    fn begin_probe(&self, owner: &str) -> bool {
        let mut owners = self.owners();
        let key = owner.to_ascii_lowercase();
        if !owners.contains_key(&key) && owners.len() >= MAX_ROUTED_OWNERS {
            let Some(oldest) = owners.keys().next().cloned() else {
                return false;
            };
            owners.remove(&oldest);
        }
        let route = owners.entry(key).or_default();
        if route
            .next_probe
            .is_some_and(|deadline| deadline.remaining().is_some())
        {
            return false;
        }
        route.next_probe = MonotonicDeadline::after(PROBE_COOLDOWN).ok();
        true
    }

    fn set_pinned(&self, owner: &str, pinned: Option<PinnedAccount>) {
        if let Some(route) = self.owners().get_mut(&owner.to_ascii_lowercase()) {
            route.pinned = pinned;
        }
    }

    fn forget(&self, owner: &str) {
        self.owners().remove(&owner.to_ascii_lowercase());
    }
}

/// The repository or resource does not exist for the account that asked:
/// GraphQL `Could not resolve to a Repository` or a REST 404.
pub(crate) fn repository_not_visible(outcome: &CommandOutcome) -> bool {
    if outcome.termination == (CommandTermination::Exited { code: 0 }) {
        return false;
    }
    let stderr = String::from_utf8_lossy(&outcome.stderr).to_ascii_lowercase();
    stderr.contains("could not resolve to a repository") || stderr.contains("(http 404)")
}

fn credentials_rejected(outcome: &CommandOutcome) -> bool {
    if outcome.termination == (CommandTermination::Exited { code: 0 }) {
        return false;
    }
    let stderr = String::from_utf8_lossy(&outcome.stderr).to_ascii_lowercase();
    stderr.contains("bad credentials") || stderr.contains("(http 401)")
}

/// Logged-in `github.com` accounts from `gh auth status --json hosts`, active
/// account first. Only healthy entries with a valid login are returned.
pub(crate) fn parse_logged_in_accounts(bytes: &[u8]) -> Vec<(String, bool)> {
    let Ok(root) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let Some(entries) = root
        .get("hosts")
        .and_then(|hosts| hosts.get(GITHUB_HOST))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut accounts: Vec<(String, bool)> = entries
        .iter()
        .filter(|entry| entry.get("state").and_then(Value::as_str) == Some("success"))
        .filter_map(|entry| {
            let login = entry.get("login").and_then(Value::as_str)?;
            valid_github_login(login).then(|| {
                (
                    login.to_owned(),
                    entry.get("active").and_then(Value::as_bool) == Some(true),
                )
            })
        })
        .collect();
    accounts.sort_by_key(|(_, active)| !active);
    accounts.dedup_by(|left, right| left.0.eq_ignore_ascii_case(&right.0));
    accounts
}

fn parse_token(bytes: &[u8]) -> Option<SecureSecret> {
    let trimmed = bytes.trim_ascii();
    (!trimmed.is_empty()
        && trimmed.len() <= MAX_TOKEN_BYTES
        && trimmed.iter().all(u8::is_ascii_graphic))
    .then(|| SecureSecret::new(trimmed.to_vec()))
    .flatten()
}

fn apply_account(request: CommandRequest, account: Option<&PinnedAccount>) -> CommandRequest {
    match account.and_then(|account| std::str::from_utf8(account.token.expose()).ok()) {
        Some(token) => request.environment("GH_TOKEN", token),
        None => request,
    }
}

impl GitHubClient {
    /// Runs one `gh` request against a repository of `owner` with the account
    /// that can see it. `build` adds the arguments and stdin to the base
    /// request and may be called more than once while accounts are probed.
    pub(crate) fn run_for_owner(
        &self,
        owner: &str,
        timeout: Duration,
        build: impl Fn(CommandRequest) -> CommandRequest,
    ) -> Result<CommandOutcome, ProviderFailure> {
        let deadline = MonotonicDeadline::after(timeout).map_err(|_| ProviderFailure::Timeout)?;
        let pinned = self.accounts.pinned(owner);
        let outcome = self.run_as(pinned.as_ref(), deadline, &build)?;
        if pinned.is_some() && credentials_rejected(&outcome) {
            // The pinned token was revoked; fall back to the active account
            // and let the next not-visible answer probe again.
            self.accounts.forget(owner);
            return self.run_as(None, deadline, &build);
        }
        if !repository_not_visible(&outcome) || !self.accounts.begin_probe(owner) {
            return Ok(outcome);
        }
        let tried = pinned.as_ref().map(|account| account.login.clone());
        let accounts = self.logged_in_accounts(deadline);
        for (login, active) in accounts {
            if tried
                .as_ref()
                .is_some_and(|tried| tried.eq_ignore_ascii_case(&login))
                || (tried.is_none() && active)
            {
                continue;
            }
            let candidate = if active {
                None
            } else {
                match self.account_token(&login, deadline) {
                    Some(token) => Some(PinnedAccount {
                        login,
                        token: Arc::new(token),
                    }),
                    None => continue,
                }
            };
            let Ok(retried) = self.run_as(candidate.as_ref(), deadline, &build) else {
                continue;
            };
            if !repository_not_visible(&retried) && !credentials_rejected(&retried) {
                self.accounts.set_pinned(owner, candidate);
                return Ok(retried);
            }
        }
        Ok(outcome)
    }

    fn run_as(
        &self,
        account: Option<&PinnedAccount>,
        deadline: MonotonicDeadline,
        build: &impl Fn(CommandRequest) -> CommandRequest,
    ) -> Result<CommandOutcome, ProviderFailure> {
        let remaining = deadline.remaining().ok_or(ProviderFailure::Timeout)?;
        let request = build(apply_account(self.base_request(remaining)?, account));
        termloop_platform::run_command(request).map_err(|_| ProviderFailure::ProviderUnavailable)
    }

    fn logged_in_accounts(&self, deadline: MonotonicDeadline) -> Vec<(String, bool)> {
        let Some(remaining) = deadline.remaining() else {
            return Vec::new();
        };
        let Ok(request) = self.base_request(remaining.min(ACCOUNT_LOOKUP_TIMEOUT)) else {
            return Vec::new();
        };
        match termloop_platform::run_command(request.args([
            "auth",
            "status",
            "--hostname",
            GITHUB_HOST,
            "--json",
            "hosts",
        ])) {
            Ok(outcome) if !outcome.stdout_truncated => parse_logged_in_accounts(&outcome.stdout),
            _ => Vec::new(),
        }
    }

    fn account_token(&self, login: &str, deadline: MonotonicDeadline) -> Option<SecureSecret> {
        let remaining = deadline.remaining()?;
        let request = self
            .base_request(remaining.min(ACCOUNT_LOOKUP_TIMEOUT))
            .ok()?;
        let outcome = termloop_platform::run_command(request.args([
            "auth",
            "token",
            "--hostname",
            GITHUB_HOST,
            "--user",
            login,
        ]))
        .ok()?;
        (outcome.termination == (CommandTermination::Exited { code: 0 })
            && !outcome.stdout_truncated)
            .then(|| parse_token(&outcome.stdout))
            .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(code: i32, stderr: &str) -> CommandOutcome {
        CommandOutcome {
            termination: CommandTermination::Exited { code },
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }

    #[test]
    fn not_visible_covers_graphql_and_rest_misses_only_on_failure() {
        assert!(repository_not_visible(&outcome(
            1,
            "gh: Could not resolve to a Repository with the name 'acme/widget'."
        )));
        assert!(repository_not_visible(&outcome(
            1,
            "gh: Not Found (HTTP 404)"
        )));
        assert!(!repository_not_visible(&outcome(
            1,
            "error connecting to api.github.com"
        )));
        assert!(!repository_not_visible(&outcome(
            0,
            "Could not resolve to a Repository"
        )));
        assert!(credentials_rejected(&outcome(
            1,
            "gh: Bad credentials (HTTP 401)"
        )));
    }

    #[test]
    fn a_repository_visibility_miss_is_not_reported_as_offline() {
        let exited = CommandTermination::Exited { code: 1 };
        assert_eq!(
            crate::classify_termination(
                &exited,
                b"gh: Could not resolve to a Repository with the name 'acme/widget'."
            ),
            Err(ProviderFailure::ProviderFailure)
        );
        assert_eq!(
            crate::classify_termination(&exited, b"could not resolve host: api.github.com"),
            Err(ProviderFailure::Offline)
        );
    }

    #[test]
    fn accounts_are_healthy_valid_logins_with_the_active_one_first() {
        let accounts = parse_logged_in_accounts(
            br#"{"hosts":{"github.com":[
                {"state":"success","active":false,"login":"work-account"},
                {"state":"success","active":true,"login":"personal"},
                {"state":"error","active":false,"login":"expired"},
                {"state":"success","active":false,"login":"bad login"}
            ],"ghe.example":[{"state":"success","active":true,"login":"other"}]}}"#,
        );
        assert_eq!(
            accounts,
            vec![
                ("personal".to_owned(), true),
                ("work-account".to_owned(), false)
            ]
        );
        assert!(parse_logged_in_accounts(b"not json").is_empty());
    }

    #[test]
    fn tokens_are_trimmed_visible_ascii() {
        assert_eq!(
            parse_token(b"gho_abc123\n").map(|token| token.expose().to_vec()),
            Some(b"gho_abc123".to_vec())
        );
        assert!(parse_token(b"\n").is_none());
        assert!(parse_token(b"has space").is_none());
    }

    #[test]
    fn probes_cool_down_per_owner_and_pins_are_case_insensitive() {
        let router = GitHubAccountRouter::default();
        assert!(router.begin_probe("Acme"));
        assert!(!router.begin_probe("acme"), "a recent probe cools down");
        assert!(router.begin_probe("other"));
        router.set_pinned(
            "acme",
            Some(PinnedAccount {
                login: "work".into(),
                token: Arc::new(SecureSecret::new(b"t".to_vec()).expect("token")),
            }),
        );
        assert_eq!(
            router.pinned("ACME").map(|pin| pin.login),
            Some("work".into())
        );
        router.forget("acme");
        assert!(router.pinned("acme").is_none());
        assert!(router.begin_probe("acme"), "forgetting clears the cooldown");
    }
}
