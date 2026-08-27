#![forbid(unsafe_code)]

mod jira;
mod pull_request_changes;

pub use jira::{
    JiraBoard, JiraBoardListResult, JiraBoardSource, JiraCloudClient, JiraCredential,
    JiraIssueRefError, JiraIssueSnapshot, JiraIssueSource, JiraSearchError, JiraSearchRequest,
    JiraSearchResult, JiraSearchScope, NormalizedJiraIssueRef, normalize_jira_issue_url,
    normalize_jira_site_base_url,
};

pub use pull_request_changes::{
    ProviderPullRequestChange, ProviderPullRequestChangeKind, ProviderPullRequestChangeList,
    ProviderPullRequestDiff, ProviderPullRequestDiffState, PullRequestChangeIdentity,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use termloop_platform::{CommandRequest, CommandTermination};
use unicode_normalization::UnicodeNormalization;

const GITHUB_HOST: &str = "github.com";
const MAX_BATCH_QUERIES: usize = 20;
const MAX_MATCHES: usize = 16;
const MAX_STDIN: usize = 128 * 1024;
const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const AZURE_HOST: &str = "dev.azure.com";
const AZURE_SSH_HOST: &str = "ssh.dev.azure.com";
const AZURE_MAX_MATCHES: usize = 16;
const AZURE_QUERY_ROWS: usize = AZURE_MAX_MATCHES + 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitHostProvider {
    Github,
    AzureDevOps,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitHubRepository {
    pub owner: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AzureRepository {
    pub organization: String,
    pub project: String,
    pub name: String,
}

impl AzureRepository {
    pub fn project_key(&self) -> String {
        format!(
            "azureDevOps|{AZURE_HOST}|{}|{}",
            self.organization,
            azure_name_key(&self.project)
        )
    }

    pub fn repository_key(&self) -> String {
        format!("{}|{}", self.project_key(), azure_name_key(&self.name))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AzurePullRequestQuery {
    pub repository: AzureRepository,
    pub head_branch: String,
}

impl AzurePullRequestQuery {
    pub fn alias_key(&self) -> String {
        format!(
            "{}|{}",
            self.repository.repository_key(),
            serde_json::to_string(&self.head_branch).expect("branch string serializes")
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PullRequestQuery {
    pub repository: GitHubRepository,
    pub head_branch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Passing,
    Failing,
    Pending,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    ReviewRequired,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mergeability {
    Mergeable,
    Conflicting,
    Blocked,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PullRequestSummary {
    pub provider: GitHostProvider,
    pub host: String,
    pub repository_owner: String,
    pub repository_project: Option<String>,
    pub repository_name: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: PullRequestState,
    pub base_branch: String,
    pub head_branch: String,
    pub head_repository_owner: String,
    pub head_repository_project: Option<String>,
    pub head_repository_name: String,
    pub checks: CheckState,
    pub review: ReviewState,
    pub mergeability: Mergeability,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AzurePullRequestScan {
    pub pull_requests: Vec<PullRequestSummary>,
    pub truncated: bool,
    pub incomplete: bool,
    pub parent_resolved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AzureRepositoryRelationship {
    NonFork,
    Fork(AzureRepository),
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderFailure {
    ProviderUnavailable,
    Unauthorized,
    Offline,
    RateLimited,
    Timeout,
    OutputLimit,
    MalformedResponse,
    ProviderFailure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestQueryResult {
    pub query: PullRequestQuery,
    pub matches: Vec<PullRequestSummary>,
    pub truncated: bool,
    pub parent_resolved: bool,
    pub failure: Option<ProviderFailure>,
    pub retry_after_epoch_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteIdentityError {
    Malformed,
    UnsupportedHost,
    UnsupportedTransport,
}

pub fn parse_github_remote(raw: &[u8]) -> Result<GitHubRepository, RemoteIdentityError> {
    let value = std::str::from_utf8(raw).map_err(|_| RemoteIdentityError::Malformed)?;
    if value.bytes().any(|byte| byte.is_ascii_control())
        || value.contains('?')
        || value.contains('#')
    {
        return Err(RemoteIdentityError::Malformed);
    }

    let path = if let Some(rest) = value.strip_prefix("https://") {
        if rest.contains('@') {
            return Err(RemoteIdentityError::Malformed);
        }
        let (host, path) = rest.split_once('/').ok_or(RemoteIdentityError::Malformed)?;
        if !host.eq_ignore_ascii_case(GITHUB_HOST) {
            return Err(RemoteIdentityError::UnsupportedHost);
        }
        path
    } else if let Some(rest) = value.strip_prefix("ssh://") {
        let (authority, path) = rest.split_once('/').ok_or(RemoteIdentityError::Malformed)?;
        let host = match authority.split_once('@') {
            Some(("git", host)) => host,
            Some(_) => return Err(RemoteIdentityError::Malformed),
            None => authority,
        };
        if !host.eq_ignore_ascii_case(GITHUB_HOST) {
            return Err(RemoteIdentityError::UnsupportedHost);
        }
        path
    } else if let Some(rest) = value.strip_prefix("git@") {
        let (host, path) = rest.split_once(':').ok_or(RemoteIdentityError::Malformed)?;
        if !host.eq_ignore_ascii_case(GITHUB_HOST) {
            return Err(RemoteIdentityError::UnsupportedHost);
        }
        path
    } else {
        return Err(RemoteIdentityError::UnsupportedTransport);
    };
    parse_repository_path(path)
}

pub fn parse_azure_remote(raw: &[u8]) -> Result<AzureRepository, RemoteIdentityError> {
    let value = std::str::from_utf8(raw).map_err(|_| RemoteIdentityError::Malformed)?;
    if value.bytes().any(|byte| byte.is_ascii_control())
        || value.contains('?')
        || value.contains('#')
    {
        return Err(RemoteIdentityError::Malformed);
    }

    let (organization, project, repository) = if let Some(rest) = value.strip_prefix("https://") {
        let (authority, path) = rest.split_once('/').ok_or(RemoteIdentityError::Malformed)?;
        let (userinfo, host) = match authority.rsplit_once('@') {
            Some((userinfo, host)) => (Some(userinfo), host),
            None => (None, authority),
        };
        if !host.eq_ignore_ascii_case(AZURE_HOST) || host.contains(':') {
            return Err(RemoteIdentityError::UnsupportedHost);
        }
        let mut segments = path.split('/');
        let organization = segments.next().ok_or(RemoteIdentityError::Malformed)?;
        let project = segments.next().ok_or(RemoteIdentityError::Malformed)?;
        if segments.next() != Some("_git") {
            return Err(RemoteIdentityError::Malformed);
        }
        let repository = segments.next().ok_or(RemoteIdentityError::Malformed)?;
        if segments.next().is_some() {
            return Err(RemoteIdentityError::Malformed);
        }
        let organization = normalize_organization(organization)?;
        if let Some(userinfo) = userinfo
            && (userinfo.contains(':')
                || userinfo.contains('%')
                || normalize_organization(userinfo)? != organization)
        {
            return Err(RemoteIdentityError::Malformed);
        }
        (organization, project, repository)
    } else if let Some(rest) = value.strip_prefix("ssh://") {
        let (authority, path) = rest.split_once('/').ok_or(RemoteIdentityError::Malformed)?;
        let host = match authority.split_once('@') {
            Some(("git", host)) => host,
            Some(_) => return Err(RemoteIdentityError::Malformed),
            None => authority,
        };
        if !host.eq_ignore_ascii_case(AZURE_SSH_HOST) || host.contains(':') {
            return Err(RemoteIdentityError::UnsupportedHost);
        }
        parse_azure_ssh_path(path)?
    } else if let Some(rest) = value.strip_prefix("git@") {
        let (host, path) = rest.split_once(':').ok_or(RemoteIdentityError::Malformed)?;
        if !host.eq_ignore_ascii_case(AZURE_SSH_HOST) {
            return Err(RemoteIdentityError::UnsupportedHost);
        }
        parse_azure_ssh_path(path)?
    } else {
        return Err(RemoteIdentityError::UnsupportedTransport);
    };

    Ok(AzureRepository {
        organization,
        project: normalize_azure_name(project, AzureNameKind::Project)?,
        name: normalize_azure_name(repository, AzureNameKind::Repository)?,
    })
}

fn parse_azure_ssh_path(path: &str) -> Result<(String, &str, &str), RemoteIdentityError> {
    let mut segments = path.split('/');
    if segments.next() != Some("v3") {
        return Err(RemoteIdentityError::Malformed);
    }
    let organization = segments.next().ok_or(RemoteIdentityError::Malformed)?;
    let project = segments.next().ok_or(RemoteIdentityError::Malformed)?;
    let repository = segments.next().ok_or(RemoteIdentityError::Malformed)?;
    if segments.next().is_some() {
        return Err(RemoteIdentityError::Malformed);
    }
    Ok((normalize_organization(organization)?, project, repository))
}

#[derive(Clone, Copy)]
enum AzureNameKind {
    Project,
    Repository,
}

fn normalize_organization(value: &str) -> Result<String, RemoteIdentityError> {
    if !(1..50).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
    {
        return Err(RemoteIdentityError::Malformed);
    }
    Ok(value.to_ascii_lowercase())
}

fn normalize_azure_name(encoded: &str, kind: AzureNameKind) -> Result<String, RemoteIdentityError> {
    let decoded = percent_decode_segment(encoded)?;
    normalize_azure_display_name(&decoded, kind)
}

fn normalize_azure_display_name(
    decoded: &str,
    kind: AzureNameKind,
) -> Result<String, RemoteIdentityError> {
    let normalized = decoded.nfc().collect::<String>();
    let scalar_count = normalized.chars().count();
    let utf16_count = normalized.encode_utf16().count();
    if scalar_count == 0
        || scalar_count > 64
        || utf16_count > 64
        || normalized == "."
        || normalized == ".."
        || normalized.chars().any(char::is_control)
        || normalized.contains(['/', '\\'])
        || is_system_reserved(&normalized)
    {
        return Err(RemoteIdentityError::Malformed);
    }
    let prohibited = match kind {
        AzureNameKind::Project => "\\/:*?\"'<>;#$*{},+=[]|",
        AzureNameKind::Repository => "\\/:*?\"<>;#$*{},+=[]|",
    };
    if normalized
        .chars()
        .any(|character| prohibited.contains(character))
        || normalized.starts_with('.')
        || normalized.ends_with('.')
        || normalized.starts_with('_')
        || matches!(kind, AzureNameKind::Project) && is_hidden_project_segment(&normalized)
    {
        return Err(RemoteIdentityError::Malformed);
    }
    Ok(normalized)
}

fn percent_decode_segment(value: &str) -> Result<String, RemoteIdentityError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes
                .get(index + 1)
                .and_then(|byte| hex(*byte))
                .ok_or(RemoteIdentityError::Malformed)?;
            let low = bytes
                .get(index + 2)
                .and_then(|byte| hex(*byte))
                .ok_or(RemoteIdentityError::Malformed)?;
            let byte = high * 16 + low;
            if matches!(byte, b'/' | b'\\' | b'%' | 0..=31 | 127) {
                return Err(RemoteIdentityError::Malformed);
            }
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| RemoteIdentityError::Malformed)
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn azure_name_key(value: &str) -> String {
    caseless::default_case_fold_str(&value.nfc().collect::<String>())
}

pub fn azure_name_eq(left: &str, right: &str) -> bool {
    azure_name_key(left) == azure_name_key(right)
}

fn is_system_reserved(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "AUX" | "CON" | "NUL" | "PRN" | "SERVER" | "SIGNALR" | "WEB" | "DEFAULTCOLLECTION"
    ) || (upper.starts_with("COM") || upper.starts_with("LPT"))
        && upper[3..]
            .parse::<u8>()
            .is_ok_and(|number| (1..=10).contains(&number))
}

fn is_hidden_project_segment(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "app_browsers"
            | "app_code"
            | "app_data"
            | "app_globalresources"
            | "app_localresources"
            | "app_themes"
            | "app_webresources"
            | "bin"
            | "web.config"
    )
}

fn parse_repository_path(path: &str) -> Result<GitHubRepository, RemoteIdentityError> {
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut segments = path.split('/');
    let owner = segments.next().ok_or(RemoteIdentityError::Malformed)?;
    let name = segments.next().ok_or(RemoteIdentityError::Malformed)?;
    if segments.next().is_some() || !valid_slug(owner) || !valid_slug(name) {
        return Err(RemoteIdentityError::Malformed);
    }
    Ok(GitHubRepository {
        owner: owner.to_owned(),
        name: name.to_owned(),
    })
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Builds the base spawn request for an externally installed provider CLI.
///
/// The program is resolved through the platform launch-target resolver against
/// the same allowlist-reconstructed environment the child receives, so Windows
/// `.cmd`/`.bat` shims (for example `az.cmd`) spawn through their required
/// `cmd.exe` wrapper instead of failing as a bare-name `CreateProcessW`
/// target. A missing or unusable CLI is the existing typed degraded state
/// `ProviderFailure::ProviderUnavailable`, never a silent "no PR".
fn resolved_provider_cli_request(
    program: &str,
    environment: termloop_platform::LaunchEnvironment,
) -> Result<CommandRequest, ProviderFailure> {
    let target = termloop_platform::resolve_launch_target(program, &environment)
        .map_err(|_| ProviderFailure::ProviderUnavailable)?;
    let (resolved_program, wrapper_arguments) = target.command_line(std::iter::empty::<OsString>());
    Ok(CommandRequest::new(resolved_program)
        .args(wrapper_arguments)
        .launch_environment(environment))
}

/// The resolved `gh` request with its fixed non-interactive environment.
/// Pager values are empty strings — "pager disabled" for `gh` — because a
/// pager value naming a Unix-only binary (`cat`) is not spawnable on Windows.
/// Stdout is piped (non-TTY), so this is defense in depth, not behavior.
fn github_cli_request(
    environment: termloop_platform::LaunchEnvironment,
) -> Result<CommandRequest, ProviderFailure> {
    Ok(resolved_provider_cli_request("gh", environment)?
        .environment("GH_PROMPT_DISABLED", "1")
        .environment("GH_NO_UPDATE_NOTIFIER", "1")
        .environment("GH_PAGER", "")
        .environment("PAGER", "")
        .environment("NO_COLOR", "1"))
}

#[derive(Clone)]
pub struct GitHubClient {
    registry_directory: PathBuf,
    discovery: Arc<OnceLock<()>>,
    discovery_gate: Arc<Mutex<()>>,
    sequence: Arc<AtomicU64>,
    suppression: Arc<Mutex<Option<(ProviderFailure, termloop_platform::MonotonicDeadline)>>>,
}

impl std::fmt::Debug for GitHubClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitHubClient")
            .field("registry_directory", &"<redacted>")
            .field("discovered", &self.discovery.get().is_some())
            .finish()
    }
}

impl GitHubClient {
    pub fn new(registry_directory: impl Into<PathBuf>) -> Self {
        Self {
            registry_directory: registry_directory.into(),
            discovery: Arc::new(OnceLock::new()),
            discovery_gate: Arc::new(Mutex::new(())),
            sequence: Arc::new(AtomicU64::new(0)),
            suppression: Arc::new(Mutex::new(None)),
        }
    }

    pub fn query(
        &self,
        queries: &[PullRequestQuery],
    ) -> Result<Vec<PullRequestQueryResult>, ProviderFailure> {
        self.query_with_timeout(queries, Duration::from_secs(8))
    }

    pub fn query_with_timeout(
        &self,
        queries: &[PullRequestQuery],
        timeout: Duration,
    ) -> Result<Vec<PullRequestQueryResult>, ProviderFailure> {
        if queries.is_empty() || queries.len() > MAX_BATCH_QUERIES {
            return Err(ProviderFailure::ProviderFailure);
        }
        {
            let mut suppression = self.suppression.lock().expect("GitHub suppression mutex");
            if let Some((failure, deadline)) = *suppression {
                if deadline.remaining().is_some() {
                    return Err(failure);
                }
                *suppression = None;
            }
        }
        let result = self.query_unsuppressed(queries, timeout.min(Duration::from_secs(8)));
        let suppression_failure = result
            .as_ref()
            .err()
            .copied()
            .map(|failure| (failure, None))
            .or_else(|| {
                result.as_ref().ok().and_then(|results| {
                    results.iter().find_map(|result| {
                        result
                            .failure
                            .filter(|failure| {
                                matches!(
                                    failure,
                                    ProviderFailure::Unauthorized | ProviderFailure::RateLimited
                                )
                            })
                            .map(|failure| (failure, result.retry_after_epoch_ms))
                    })
                })
            });
        if let Some((failure, retry_after)) = suppression_failure {
            self.record_suppression(failure, retry_after);
        }
        result
    }

    fn record_suppression(&self, failure: ProviderFailure, retry_after: Option<u64>) {
        if !matches!(
            failure,
            ProviderFailure::Unauthorized
                | ProviderFailure::RateLimited
                | ProviderFailure::ProviderUnavailable
        ) {
            return;
        }
        let default = match failure {
            ProviderFailure::RateLimited => Duration::from_secs(30 * 60),
            _ => Duration::from_secs(5 * 60),
        };
        let delay = retry_after
            .map(|retry_after| {
                Duration::from_millis(
                    retry_after
                        .saturating_sub(termloop_platform::current_epoch_ms())
                        .clamp(60_000, 30 * 60 * 1_000),
                )
            })
            .unwrap_or(default);
        if let Ok(deadline) = termloop_platform::MonotonicDeadline::after(delay) {
            *self.suppression.lock().expect("GitHub suppression mutex") = Some((failure, deadline));
        }
    }

    fn query_unsuppressed(
        &self,
        queries: &[PullRequestQuery],
        timeout: Duration,
    ) -> Result<Vec<PullRequestQueryResult>, ProviderFailure> {
        if self.discovery.get().is_none() {
            let _guard = self.discovery_gate.lock().expect("GitHub discovery mutex");
            if self.discovery.get().is_none() {
                self.discover(timeout)?;
                let _ = self.discovery.set(());
            }
        }
        let body = build_graphql_body(queries)?;
        if body.len() > MAX_STDIN {
            return Err(ProviderFailure::OutputLimit);
        }
        let outcome = termloop_platform::run_command(self.request(timeout)?.stdin(body))
            .map_err(|_| ProviderFailure::ProviderUnavailable)?;
        classify_termination(&outcome.termination, &outcome.stderr)?;
        if outcome.stdout_truncated || outcome.stderr_truncated {
            return Err(ProviderFailure::OutputLimit);
        }
        parse_graphql_response(
            queries,
            &outcome.stdout,
            termloop_platform::current_epoch_ms(),
        )
    }

    fn discover(&self, timeout: Duration) -> Result<(), ProviderFailure> {
        let outcome = termloop_platform::run_command(
            self.base_request(timeout.min(Duration::from_secs(2)))?
                .args(["--version"]),
        )
        .map_err(|_| ProviderFailure::ProviderUnavailable)?;
        classify_termination(&outcome.termination, &outcome.stderr)
    }

    fn request(&self, timeout: Duration) -> Result<CommandRequest, ProviderFailure> {
        Ok(self.base_request(timeout)?.args([
            "api",
            "--hostname",
            GITHUB_HOST,
            "graphql",
            "--input",
            "-",
        ]))
    }

    fn base_request(&self, timeout: Duration) -> Result<CommandRequest, ProviderFailure> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        Ok(
            github_cli_request(termloop_platform::LaunchEnvironment::os_baseline())?
                .timeout(timeout)
                .output_limit(OUTPUT_LIMIT)
                .tracked(&self.registry_directory, format!("github-{id}")),
        )
    }
}

fn classify_termination(
    termination: &CommandTermination,
    stderr: &[u8],
) -> Result<(), ProviderFailure> {
    if *termination == CommandTermination::TimedOut {
        return Err(ProviderFailure::Timeout);
    }
    if *termination == (CommandTermination::Exited { code: 0 }) {
        return Ok(());
    }
    let lower = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if lower.contains("not logged") || lower.contains("authentication") || lower.contains("401") {
        Err(ProviderFailure::Unauthorized)
    } else if lower.contains("rate limit") || lower.contains("429") {
        Err(ProviderFailure::RateLimited)
    } else if lower.contains("could not resolve")
        || lower.contains("connection")
        || lower.contains("network")
    {
        Err(ProviderFailure::Offline)
    } else {
        Err(ProviderFailure::ProviderFailure)
    }
}

fn build_graphql_body(queries: &[PullRequestQuery]) -> Result<Vec<u8>, ProviderFailure> {
    let mut query = String::from("query TermLoopPullRequests {");
    for (index, item) in queries.iter().enumerate() {
        if !valid_slug(&item.repository.owner)
            || !valid_slug(&item.repository.name)
            || item.head_branch.is_empty()
            || item.head_branch.len() > 255
            || item.head_branch.chars().any(char::is_control)
        {
            return Err(ProviderFailure::ProviderFailure);
        }
        let owner = serde_json::to_string(&item.repository.owner)
            .map_err(|_| ProviderFailure::ProviderFailure)?;
        let name = serde_json::to_string(&item.repository.name)
            .map_err(|_| ProviderFailure::ProviderFailure)?;
        let head = serde_json::to_string(&item.head_branch)
            .map_err(|_| ProviderFailure::ProviderFailure)?;
        query.push_str(&format!(
            "q{index}:repository(owner:{owner},name:{name}){{isFork pullRequests(first:17,headRefName:{head},orderBy:{{field:UPDATED_AT,direction:DESC}}){{pageInfo{{hasNextPage}} nodes{{number title state isDraft baseRefName headRefName headRepository{{nameWithOwner}} updatedAt mergeable reviewDecision commits(last:1){{nodes{{commit{{statusCheckRollup{{state}}}}}}}}}}}} parent{{nameWithOwner pullRequests(first:17,headRefName:{head},orderBy:{{field:UPDATED_AT,direction:DESC}}){{pageInfo{{hasNextPage}} nodes{{number title state isDraft baseRefName headRefName headRepository{{nameWithOwner}} updatedAt mergeable reviewDecision commits(last:1){{nodes{{commit{{statusCheckRollup{{state}}}}}}}}}}}}}}}}"
        ));
    }
    query.push_str(" rateLimit { remaining resetAt } }");
    serde_json::to_vec(&json!({ "query": query })).map_err(|_| ProviderFailure::ProviderFailure)
}

fn parse_graphql_response(
    queries: &[PullRequestQuery],
    bytes: &[u8],
    now: u64,
) -> Result<Vec<PullRequestQueryResult>, ProviderFailure> {
    let root: Value =
        serde_json::from_slice(bytes).map_err(|_| ProviderFailure::MalformedResponse)?;
    let data = root
        .get("data")
        .and_then(Value::as_object)
        .ok_or(ProviderFailure::MalformedResponse)?;
    let rate_limited = data
        .get("rateLimit")
        .and_then(|value| value.get("remaining"))
        .and_then(Value::as_u64)
        == Some(0);
    let rate_limit_retry_after = rate_limited
        .then(|| {
            data.get("rateLimit")
                .and_then(|value| value.get("resetAt"))
                .and_then(Value::as_str)
                .and_then(parse_rfc3339_epoch_ms)
                .map(|reset| {
                    now.saturating_add(reset.saturating_sub(now).clamp(60_000, 30 * 60 * 1_000))
                })
        })
        .flatten();
    let mut results = Vec::with_capacity(queries.len());
    for (index, query) in queries.iter().enumerate() {
        let repository_key = format!("q{index}");
        let failure = if rate_limited {
            Some(ProviderFailure::RateLimited)
        } else {
            classify_graphql_errors(root.get("errors"), &repository_key)
        };
        let repository = data.get(&repository_key);
        let repository_available = repository.is_some_and(|value| !value.is_null());
        let mut matches = Vec::new();
        let mut parent_resolved = true;
        let mut incomplete_or_truncated = false;
        if let Some(repository) = repository.filter(|value| !value.is_null()) {
            incomplete_or_truncated |= collect_pull_requests(
                repository.get("pullRequests"),
                query,
                &query.repository,
                &mut matches,
            );
            let is_fork = repository.get("isFork").and_then(Value::as_bool);
            incomplete_or_truncated |= is_fork.is_none();
            if is_fork == Some(true) {
                match repository.get("parent").filter(|value| !value.is_null()) {
                    Some(parent) => {
                        if let Some(parent_repository) = parent
                            .get("nameWithOwner")
                            .and_then(Value::as_str)
                            .and_then(parse_name_with_owner)
                        {
                            incomplete_or_truncated |= collect_pull_requests(
                                parent.get("pullRequests"),
                                query,
                                &parent_repository,
                                &mut matches,
                            );
                        } else {
                            parent_resolved = false;
                        }
                    }
                    None => parent_resolved = false,
                }
            }
        }
        matches.sort_by(|left, right| {
            right
                .updated_at_epoch_ms
                .cmp(&left.updated_at_epoch_ms)
                .then_with(|| left.number.cmp(&right.number))
        });
        matches.dedup_by(|left, right| {
            left.repository_owner == right.repository_owner
                && left.repository_name == right.repository_name
                && left.number == right.number
        });
        let truncated = incomplete_or_truncated || matches.len() > MAX_MATCHES;
        matches.truncate(MAX_MATCHES);
        results.push(PullRequestQueryResult {
            query: query.clone(),
            matches,
            truncated,
            parent_resolved,
            failure: failure
                .or((!repository_available).then_some(ProviderFailure::ProviderFailure)),
            retry_after_epoch_ms: (failure == Some(ProviderFailure::RateLimited))
                .then_some(rate_limit_retry_after)
                .flatten(),
        });
    }
    Ok(results)
}

fn classify_graphql_errors(
    errors: Option<&Value>,
    repository_key: &str,
) -> Option<ProviderFailure> {
    let errors = errors?.as_array()?;
    let text = errors
        .iter()
        .filter(|error| {
            error
                .get("path")
                .and_then(Value::as_array)
                .and_then(|path| path.first())
                .and_then(Value::as_str)
                .is_none_or(|alias| alias == repository_key || alias == "rateLimit")
        })
        .filter_map(|error| error.get("type").or_else(|| error.get("message")))
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if text.is_empty() {
        return None;
    }
    Some(if text.contains("rate") {
        ProviderFailure::RateLimited
    } else if text.contains("auth") || text.contains("forbidden") {
        ProviderFailure::Unauthorized
    } else {
        ProviderFailure::ProviderFailure
    })
}

fn collect_pull_requests(
    connection: Option<&Value>,
    query: &PullRequestQuery,
    base_repository: &GitHubRepository,
    output: &mut Vec<PullRequestSummary>,
) -> bool {
    let Some(connection) = connection else {
        return true;
    };
    let page_info = connection
        .get("pageInfo")
        .and_then(|value| value.get("hasNextPage"))
        .and_then(Value::as_bool);
    let Some(nodes) = connection.get("nodes").and_then(Value::as_array) else {
        return true;
    };
    let mut incomplete_or_truncated = page_info.unwrap_or(true) || nodes.len() > MAX_MATCHES;
    for node in nodes {
        match normalize_summary(node, query, base_repository) {
            NodeNormalization::Match(summary) => output.push(*summary),
            NodeNormalization::DefiniteNonMatch => {}
            NodeNormalization::Incomplete => incomplete_or_truncated = true,
        }
    }
    incomplete_or_truncated
}

enum NodeNormalization {
    Match(Box<PullRequestSummary>),
    DefiniteNonMatch,
    Incomplete,
}

fn normalize_summary(
    node: &Value,
    query: &PullRequestQuery,
    base_repository: &GitHubRepository,
) -> NodeNormalization {
    let Some(head_branch) = node.get("headRefName").and_then(Value::as_str) else {
        return NodeNormalization::Incomplete;
    };
    let head_branch = bounded_text(head_branch, 255);
    if head_branch != query.head_branch {
        return NodeNormalization::DefiniteNonMatch;
    }
    let Some(head_repository) = node
        .get("headRepository")
        .and_then(|value| value.get("nameWithOwner"))
        .and_then(Value::as_str)
    else {
        return NodeNormalization::Incomplete;
    };
    let Some((head_owner, head_name)) = head_repository.split_once('/') else {
        return NodeNormalization::Incomplete;
    };
    if !head_owner.eq_ignore_ascii_case(&query.repository.owner)
        || !head_name.eq_ignore_ascii_case(&query.repository.name)
    {
        return NodeNormalization::DefiniteNonMatch;
    }
    let Some(summary) =
        normalize_matching_summary(node, base_repository, &head_branch, head_owner, head_name)
    else {
        return NodeNormalization::Incomplete;
    };
    NodeNormalization::Match(Box::new(summary))
}

fn normalize_matching_summary(
    node: &Value,
    base_repository: &GitHubRepository,
    head_branch: &str,
    head_owner: &str,
    head_name: &str,
) -> Option<PullRequestSummary> {
    let number = node.get("number")?.as_u64()?;
    let repository_owner = base_repository.owner.clone();
    let repository_name = base_repository.name.clone();
    let url = format!("https://{GITHUB_HOST}/{repository_owner}/{repository_name}/pull/{number}");
    if url.len() > 2048 {
        return None;
    }
    let state = if node.get("isDraft").and_then(Value::as_bool) == Some(true) {
        PullRequestState::Draft
    } else {
        match node.get("state").and_then(Value::as_str)? {
            "OPEN" => PullRequestState::Open,
            "MERGED" => PullRequestState::Merged,
            "CLOSED" => PullRequestState::Closed,
            _ => return None,
        }
    };
    Some(PullRequestSummary {
        provider: GitHostProvider::Github,
        host: GITHUB_HOST.into(),
        repository_owner,
        repository_project: None,
        repository_name,
        number,
        title: bounded_text(node.get("title")?.as_str()?, 512),
        url,
        state,
        base_branch: bounded_text(node.get("baseRefName")?.as_str()?, 255),
        head_branch: head_branch.to_owned(),
        head_repository_owner: head_owner.to_owned(),
        head_repository_project: None,
        head_repository_name: head_name.to_owned(),
        checks: map_checks(node),
        review: map_review(node.get("reviewDecision").and_then(Value::as_str)),
        mergeability: map_mergeability(node.get("mergeable").and_then(Value::as_str)),
        updated_at_epoch_ms: parse_rfc3339_epoch_ms(node.get("updatedAt")?.as_str()?)?,
    })
}

fn parse_name_with_owner(value: &str) -> Option<GitHubRepository> {
    let (owner, name) = value.split_once('/')?;
    (valid_slug(owner) && valid_slug(name)).then(|| GitHubRepository {
        owner: owner.to_owned(),
        name: name.to_owned(),
    })
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn parse_rfc3339_epoch_ms(value: &str) -> Option<u64> {
    let (timestamp, offset_seconds) = if let Some(timestamp) = value.strip_suffix('Z') {
        (timestamp, 0_i64)
    } else {
        let offset_start = value.len().checked_sub(6)?;
        let (timestamp, offset) = value.split_at(offset_start);
        let sign = match offset.as_bytes().first() {
            Some(b'+') => 1_i64,
            Some(b'-') => -1_i64,
            _ => return None,
        };
        if offset.as_bytes().get(3) != Some(&b':') {
            return None;
        }
        let hours = offset.get(1..3)?.parse::<i64>().ok()?;
        let minutes = offset.get(4..6)?.parse::<i64>().ok()?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        (timestamp, sign * (hours * 3_600 + minutes * 60))
    };
    if timestamp.len() < 19 || timestamp.as_bytes().get(4) != Some(&b'-') {
        return None;
    }
    let year = timestamp.get(0..4)?.parse::<i64>().ok()?;
    let month = timestamp.get(5..7)?.parse::<i64>().ok()?;
    let day = timestamp.get(8..10)?.parse::<i64>().ok()?;
    let hour = timestamp.get(11..13)?.parse::<i64>().ok()?;
    let minute = timestamp.get(14..16)?.parse::<i64>().ok()?;
    let second = timestamp.get(17..19)?.parse::<i64>().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let fraction = timestamp.get(19..)?;
    let millis = if fraction.is_empty() {
        0
    } else {
        let digits = fraction.strip_prefix('.')?;
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let mut padded = digits.chars().take(3).collect::<String>();
        while padded.len() < 3 {
            padded.push('0');
        }
        padded.parse::<i64>().ok()?
    };
    let days = days_from_civil(year, month, day);
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(hour * 3_600 + minute * 60 + second)?
        .checked_sub(offset_seconds)?;
    u64::try_from(seconds.checked_mul(1_000)?.checked_add(millis)?).ok()
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn map_checks(node: &Value) -> CheckState {
    match node
        .pointer("/commits/nodes/0/commit/statusCheckRollup/state")
        .and_then(Value::as_str)
    {
        Some("SUCCESS") => CheckState::Passing,
        Some("FAILURE" | "ERROR") => CheckState::Failing,
        Some("PENDING" | "EXPECTED") => CheckState::Pending,
        _ => CheckState::Unknown,
    }
}

fn map_review(value: Option<&str>) -> ReviewState {
    match value {
        Some("APPROVED") => ReviewState::Approved,
        Some("CHANGES_REQUESTED") => ReviewState::ChangesRequested,
        Some("REVIEW_REQUIRED") => ReviewState::ReviewRequired,
        _ => ReviewState::Unknown,
    }
}

fn map_mergeability(value: Option<&str>) -> Mergeability {
    match value {
        Some("MERGEABLE") => Mergeability::Mergeable,
        Some("CONFLICTING") => Mergeability::Conflicting,
        _ => Mergeability::Unknown,
    }
}

const AZURE_PR_QUERY: &str = "[].{pullRequestId:pullRequestId,title:title,status:status,isDraft:isDraft,sourceRefName:sourceRefName,targetRefName:targetRefName,mergeStatus:mergeStatus,creationDate:creationDate,closedDate:closedDate,sourceCommitDate:lastMergeSourceCommit.committer.date,repository:{name:repository.name,project:repository.project.name},forkSource:{repository:{name:forkSource.repository.name,project:forkSource.repository.project.name}},reviewers:reviewers[?isRequired].{vote:vote,isRequired:isRequired}}";
const AZURE_REPOSITORY_QUERY: &str = "{name:name,project:project.name,parentRepository:{name:parentRepository.name,project:parentRepository.project.name}}";

/// The resolved `az` request with its fixed non-interactive environment.
/// `az` installs as `az.cmd` on Windows, so resolution through the platform
/// launch-target resolver is mandatory there. The pager value is an empty
/// string ("disabled") rather than a Unix-only `cat` binary; stdout is piped
/// (non-TTY), so this is defense in depth, not behavior.
fn azure_cli_request(
    environment: termloop_platform::LaunchEnvironment,
) -> Result<CommandRequest, ProviderFailure> {
    Ok(resolved_provider_cli_request("az", environment)?
        .environment("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")
        .environment("AZURE_EXTENSION_RUN_AFTER_DYNAMIC_INSTALL", "no")
        .environment("AZURE_CORE_COLLECT_TELEMETRY", "no")
        .environment("AZURE_CORE_ONLY_SHOW_ERRORS", "yes")
        .environment("AZURE_CORE_NO_COLOR", "yes")
        .environment("AZURE_CORE_DISABLE_CONFIRM_PROMPT", "yes")
        .environment("AZURE_CORE_SURVEY_MESSAGE", "no")
        .environment("AZURE_LOGGING_ENABLE_LOG_FILE", "no")
        .environment("NO_COLOR", "1")
        .environment("PAGER", ""))
}

#[derive(Clone)]
pub struct AzureDevOpsClient {
    registry_directory: PathBuf,
    discovery: Arc<OnceLock<()>>,
    discovery_failure: Arc<OnceLock<ProviderFailure>>,
    discovery_gate: Arc<Mutex<()>>,
    sequence: Arc<AtomicU64>,
    suppression:
        Arc<Mutex<BTreeMap<String, (ProviderFailure, termloop_platform::MonotonicDeadline)>>>,
}

impl std::fmt::Debug for AzureDevOpsClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AzureDevOpsClient")
            .field("registry_directory", &"<redacted>")
            .field("discovered", &self.discovery.get().is_some())
            .field("discovery_failed", &self.discovery_failure.get().is_some())
            .finish()
    }
}

impl AzureDevOpsClient {
    pub fn new(registry_directory: impl Into<PathBuf>) -> Self {
        Self {
            registry_directory: registry_directory.into(),
            discovery: Arc::new(OnceLock::new()),
            discovery_failure: Arc::new(OnceLock::new()),
            discovery_gate: Arc::new(Mutex::new(())),
            sequence: Arc::new(AtomicU64::new(0)),
            suppression: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub fn query_pull_requests_with_timeout(
        &self,
        query: &AzurePullRequestQuery,
        known_target: Option<&AzureRepository>,
        timeout: Duration,
    ) -> Result<AzurePullRequestScan, ProviderFailure> {
        let deadline =
            termloop_platform::MonotonicDeadline::after(timeout.min(Duration::from_secs(8)))
                .map_err(|_| ProviderFailure::Timeout)?;
        let organization = normalize_organization(&query.repository.organization)
            .map_err(|_| ProviderFailure::ProviderFailure)?;
        let project =
            normalize_azure_display_name(&query.repository.project, AzureNameKind::Project)
                .map_err(|_| ProviderFailure::ProviderFailure)?;
        let repository =
            normalize_azure_display_name(&query.repository.name, AzureNameKind::Repository)
                .map_err(|_| ProviderFailure::ProviderFailure)?;
        let head_branch =
            normalize_branch(&query.head_branch).ok_or(ProviderFailure::ProviderFailure)?;
        let query = AzurePullRequestQuery {
            repository: AzureRepository {
                organization,
                project,
                name: repository,
            },
            head_branch,
        };
        let known_target = known_target
            .map(|target| normalize_known_target(&query, target))
            .transpose()?;
        let alias_key = query.alias_key();
        let project_key = query.repository.project_key();
        self.check_suppression(&project_key, &alias_key)?;
        self.ensure_discovered(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?;
        let mut scan =
            self.execute_pull_request_query(&query, known_target.as_ref(), &alias_key, deadline)?;
        if scan.truncated || scan.incomplete {
            return Ok(scan);
        }
        if known_target.is_some() || !scan.pull_requests.is_empty() {
            scan.parent_resolved = true;
            return Ok(scan);
        }
        match self.query_repository_relationship(&query, &alias_key, deadline)? {
            AzureRepositoryRelationship::NonFork => {
                scan.parent_resolved = true;
                Ok(scan)
            }
            AzureRepositoryRelationship::Fork(target) => {
                let mut target_scan =
                    self.execute_pull_request_query(&query, Some(&target), &alias_key, deadline)?;
                target_scan.parent_resolved = !target_scan.truncated && !target_scan.incomplete;
                Ok(target_scan)
            }
            AzureRepositoryRelationship::Incomplete => {
                scan.incomplete = true;
                Ok(scan)
            }
        }
    }

    fn execute_pull_request_query(
        &self,
        query: &AzurePullRequestQuery,
        known_target: Option<&AzureRepository>,
        alias_key: &str,
        deadline: termloop_platform::MonotonicDeadline,
    ) -> Result<AzurePullRequestScan, ProviderFailure> {
        let project_key = known_target.map_or_else(
            || query.repository.project_key(),
            AzureRepository::project_key,
        );
        let outcome = termloop_platform::run_command(
            self.base_request(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?
                .args(azure_pull_request_arguments(query, known_target)),
        )
        .map_err(|_| ProviderFailure::ProviderUnavailable)?;
        self.classify_query_outcome(&project_key, alias_key, &outcome)?;
        parse_azure_pull_request_scan(query.clone(), known_target, &outcome.stdout)
    }

    fn query_repository_relationship(
        &self,
        query: &AzurePullRequestQuery,
        alias_key: &str,
        deadline: termloop_platform::MonotonicDeadline,
    ) -> Result<AzureRepositoryRelationship, ProviderFailure> {
        let project_key = query.repository.project_key();
        let outcome = termloop_platform::run_command(
            self.base_request(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?
                .args(azure_repository_arguments(query)),
        )
        .map_err(|_| ProviderFailure::ProviderUnavailable)?;
        self.classify_query_outcome(&project_key, alias_key, &outcome)?;
        parse_azure_repository_relationship(query, &outcome.stdout)
    }

    fn ensure_discovered(&self, timeout: Duration) -> Result<(), ProviderFailure> {
        if self.discovery.get().is_some() {
            return Ok(());
        }
        if let Some(failure) = self.discovery_failure.get() {
            return Err(*failure);
        }
        let _guard = self.discovery_gate.lock().expect("Azure discovery mutex");
        if self.discovery.get().is_some() {
            return Ok(());
        }
        if let Some(failure) = self.discovery_failure.get() {
            return Err(*failure);
        }
        let result = self.discover(timeout);
        match result {
            Ok(()) => {
                let _ = self.discovery.set(());
                Ok(())
            }
            Err(failure) => {
                if cacheable_discovery_failure(failure) {
                    let _ = self.discovery_failure.set(failure);
                }
                Err(failure)
            }
        }
    }

    fn discover(&self, timeout: Duration) -> Result<(), ProviderFailure> {
        let deadline = termloop_platform::MonotonicDeadline::after(timeout)
            .map_err(|_| ProviderFailure::Timeout)?;
        for arguments in [
            vec!["version", "--output", "json"],
            vec![
                "extension",
                "show",
                "--name",
                "azure-devops",
                "--output",
                "json",
                "--only-show-errors",
            ],
        ] {
            let remaining = deadline.remaining().ok_or(ProviderFailure::Timeout)?;
            let outcome =
                termloop_platform::run_command(self.base_request(remaining)?.args(arguments))
                    .map_err(|_| ProviderFailure::ProviderUnavailable)?;
            classify_azure_discovery(&outcome)?;
        }
        let remaining = deadline.remaining().ok_or(ProviderFailure::Timeout)?;
        let cloud = termloop_platform::run_command(self.base_request(remaining)?.args([
            "cloud",
            "show",
            "--query",
            "name",
            "--output",
            "tsv",
            "--only-show-errors",
        ]))
        .map_err(|_| ProviderFailure::ProviderUnavailable)?;
        classify_azure_discovery(&cloud)?;
        if cloud.stdout != b"AzureCloud\n" && cloud.stdout != b"AzureCloud\r\n" {
            return Err(ProviderFailure::ProviderUnavailable);
        }
        Ok(())
    }

    fn base_request(&self, timeout: Duration) -> Result<CommandRequest, ProviderFailure> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        Ok(
            azure_cli_request(termloop_platform::LaunchEnvironment::os_baseline())?
                .timeout(timeout)
                .output_limit(OUTPUT_LIMIT)
                .tracked(&self.registry_directory, format!("azure-devops-{id}")),
        )
    }

    fn classify_query_outcome(
        &self,
        project_key: &str,
        alias_key: &str,
        outcome: &termloop_platform::CommandOutcome,
    ) -> Result<(), ProviderFailure> {
        if outcome.stdout_truncated || outcome.stderr_truncated {
            return Err(ProviderFailure::OutputLimit);
        }
        if let Err(failure) = classify_azure_termination(&outcome.termination, &outcome.stderr) {
            if matches!(
                failure,
                ProviderFailure::Unauthorized | ProviderFailure::RateLimited
            ) && let Ok(deadline) =
                termloop_platform::MonotonicDeadline::after(Duration::from_secs(5 * 60))
            {
                let mut suppression = self.suppression.lock().expect("Azure suppression mutex");
                while suppression.len() >= 256 {
                    let Some(oldest_key) = suppression.keys().next().cloned() else {
                        break;
                    };
                    suppression.remove(&oldest_key);
                }
                let key = if failure == ProviderFailure::Unauthorized {
                    project_key
                } else {
                    alias_key
                };
                suppression.insert(key.to_owned(), (failure, deadline));
            }
            return Err(failure);
        }
        Ok(())
    }

    fn check_suppression(&self, project_key: &str, alias_key: &str) -> Result<(), ProviderFailure> {
        let mut suppression = self.suppression.lock().expect("Azure suppression mutex");
        for key in [project_key, alias_key] {
            if let Some((failure, deadline)) = suppression.get(key).copied() {
                if deadline.remaining().is_some() {
                    return Err(failure);
                }
                suppression.remove(key);
            }
        }
        Ok(())
    }
}

fn azure_pull_request_arguments(
    query: &AzurePullRequestQuery,
    known_target: Option<&AzureRepository>,
) -> Vec<String> {
    let target_project = known_target.map_or(query.repository.project.as_str(), |target| {
        target.project.as_str()
    });
    let mut arguments = vec![
        "repos".into(),
        "pr".into(),
        "list".into(),
        "--organization".into(),
        format!("https://{AZURE_HOST}/{}", query.repository.organization),
        "--project".into(),
        target_project.into(),
        "--source-branch".into(),
        query.head_branch.clone(),
        "--status".into(),
        "all".into(),
        "--top".into(),
        AZURE_QUERY_ROWS.to_string(),
    ];
    if let Some(target) = known_target {
        arguments.extend(["--repository".into(), target.name.clone()]);
    }
    arguments.extend([
        "--detect".into(),
        "false".into(),
        "--query".into(),
        AZURE_PR_QUERY.into(),
        "--output".into(),
        "json".into(),
        "--only-show-errors".into(),
    ]);
    arguments
}

fn azure_repository_arguments(query: &AzurePullRequestQuery) -> Vec<String> {
    vec![
        "repos".into(),
        "show".into(),
        "--organization".into(),
        format!("https://{AZURE_HOST}/{}", query.repository.organization),
        "--project".into(),
        query.repository.project.clone(),
        "--repository".into(),
        query.repository.name.clone(),
        "--detect".into(),
        "false".into(),
        "--query".into(),
        AZURE_REPOSITORY_QUERY.into(),
        "--output".into(),
        "json".into(),
        "--only-show-errors".into(),
    ]
}

fn cacheable_discovery_failure(failure: ProviderFailure) -> bool {
    failure == ProviderFailure::ProviderUnavailable
}

fn classify_azure_discovery(
    outcome: &termloop_platform::CommandOutcome,
) -> Result<(), ProviderFailure> {
    if outcome.stdout_truncated || outcome.stderr_truncated {
        return Err(ProviderFailure::OutputLimit);
    }
    classify_azure_termination(&outcome.termination, &outcome.stderr).map_err(|failure| {
        match failure {
            ProviderFailure::Timeout | ProviderFailure::OutputLimit => failure,
            _ => ProviderFailure::ProviderUnavailable,
        }
    })
}

fn classify_azure_termination(
    termination: &CommandTermination,
    stderr: &[u8],
) -> Result<(), ProviderFailure> {
    if *termination == CommandTermination::TimedOut {
        return Err(ProviderFailure::Timeout);
    }
    if *termination == (CommandTermination::Exited { code: 0 }) {
        return Ok(());
    }
    let lower = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthorized")
        || lower.contains("not authorized")
        || lower.contains("authentication")
    {
        Err(ProviderFailure::Unauthorized)
    } else if lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
    {
        Err(ProviderFailure::RateLimited)
    } else if lower.contains("could not resolve")
        || lower.contains("connection")
        || lower.contains("network")
        || lower.contains("timed out")
    {
        Err(ProviderFailure::Offline)
    } else {
        Err(ProviderFailure::ProviderFailure)
    }
}

fn parse_azure_pull_request_scan(
    query: AzurePullRequestQuery,
    known_target: Option<&AzureRepository>,
    bytes: &[u8],
) -> Result<AzurePullRequestScan, ProviderFailure> {
    let rows: Vec<Value> =
        serde_json::from_slice(bytes).map_err(|_| ProviderFailure::MalformedResponse)?;
    let mut incomplete = rows.len() > AZURE_QUERY_ROWS;
    let truncated = rows.len() >= AZURE_QUERY_ROWS;
    let mut pull_requests = Vec::new();
    for row in rows.iter().take(AZURE_MAX_MATCHES) {
        match normalize_azure_summary(&query, known_target, row) {
            Some(summary) if azure_summary_matches_alias(&summary, &query) => {
                pull_requests.push(summary);
            }
            Some(_) => {}
            None => incomplete = true,
        }
    }
    pull_requests.sort_by(|left, right| {
        right
            .updated_at_epoch_ms
            .cmp(&left.updated_at_epoch_ms)
            .then_with(|| left.number.cmp(&right.number))
    });
    Ok(AzurePullRequestScan {
        pull_requests,
        truncated,
        incomplete,
        parent_resolved: false,
    })
}

fn parse_azure_repository_relationship(
    query: &AzurePullRequestQuery,
    bytes: &[u8],
) -> Result<AzureRepositoryRelationship, ProviderFailure> {
    let row: Value =
        serde_json::from_slice(bytes).map_err(|_| ProviderFailure::MalformedResponse)?;
    let Some(name) = row
        .get("name")
        .and_then(Value::as_str)
        .and_then(|value| normalize_azure_display_name(value, AzureNameKind::Repository).ok())
    else {
        return Ok(AzureRepositoryRelationship::Incomplete);
    };
    let Some(project) = row
        .get("project")
        .and_then(Value::as_str)
        .and_then(|value| normalize_azure_display_name(value, AzureNameKind::Project).ok())
    else {
        return Ok(AzureRepositoryRelationship::Incomplete);
    };
    if !azure_name_eq(&name, &query.repository.name)
        || !azure_name_eq(&project, &query.repository.project)
    {
        return Ok(AzureRepositoryRelationship::Incomplete);
    }
    let Some(parent) = row
        .get("parentRepository")
        .filter(|value| value.is_object())
    else {
        return Ok(AzureRepositoryRelationship::Incomplete);
    };
    let parent_name = parent.get("name").and_then(Value::as_str);
    let parent_project = parent.get("project").and_then(Value::as_str);
    match (parent_project, parent_name) {
        (None, None) => Ok(AzureRepositoryRelationship::NonFork),
        (Some(project), Some(name)) => {
            let (Ok(project), Ok(name)) = (
                normalize_azure_display_name(project, AzureNameKind::Project),
                normalize_azure_display_name(name, AzureNameKind::Repository),
            ) else {
                return Ok(AzureRepositoryRelationship::Incomplete);
            };
            Ok(AzureRepositoryRelationship::Fork(AzureRepository {
                organization: query.repository.organization.clone(),
                project,
                name,
            }))
        }
        _ => Ok(AzureRepositoryRelationship::Incomplete),
    }
}

fn normalize_known_target(
    query: &AzurePullRequestQuery,
    target: &AzureRepository,
) -> Result<AzureRepository, ProviderFailure> {
    let organization = normalize_organization(&target.organization)
        .map_err(|_| ProviderFailure::ProviderFailure)?;
    if organization != query.repository.organization {
        return Err(ProviderFailure::ProviderFailure);
    }
    Ok(AzureRepository {
        organization,
        project: normalize_azure_display_name(&target.project, AzureNameKind::Project)
            .map_err(|_| ProviderFailure::ProviderFailure)?,
        name: normalize_azure_display_name(&target.name, AzureNameKind::Repository)
            .map_err(|_| ProviderFailure::ProviderFailure)?,
    })
}

fn normalize_branch(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 1024
        && !value.starts_with("refs/")
        && !value.chars().any(char::is_control))
    .then(|| value.to_owned())
}

fn azure_summary_matches_alias(
    summary: &PullRequestSummary,
    query: &AzurePullRequestQuery,
) -> bool {
    summary.head_branch == query.head_branch
        && summary.head_repository_owner == query.repository.organization
        && summary
            .head_repository_project
            .as_deref()
            .is_some_and(|project| azure_name_eq(project, &query.repository.project))
        && azure_name_eq(&summary.head_repository_name, &query.repository.name)
}

fn normalize_azure_summary(
    query: &AzurePullRequestQuery,
    known_target: Option<&AzureRepository>,
    row: &Value,
) -> Option<PullRequestSummary> {
    let repository = row.get("repository")?;
    let repository_project =
        normalize_azure_display_name(repository.get("project")?.as_str()?, AzureNameKind::Project)
            .ok()?;
    let expected_project = known_target.map_or(query.repository.project.as_str(), |target| {
        target.project.as_str()
    });
    if !azure_name_eq(&repository_project, expected_project) {
        return None;
    }
    let repository_name =
        normalize_azure_display_name(repository.get("name")?.as_str()?, AzureNameKind::Repository)
            .ok()?;
    if known_target.is_some_and(|target| !azure_name_eq(&repository_name, &target.name)) {
        return None;
    }
    let fork_repository = row.get("forkSource")?.get("repository")?;
    let (head_repository_project, head_repository_name) = match (
        fork_repository.get("project").and_then(Value::as_str),
        fork_repository.get("name").and_then(Value::as_str),
    ) {
        (None, None) => (repository_project.clone(), repository_name.clone()),
        (Some(project), Some(name)) => (
            normalize_azure_display_name(project, AzureNameKind::Project).ok()?,
            normalize_azure_display_name(name, AzureNameKind::Repository).ok()?,
        ),
        _ => return None,
    };
    let number = row.get("pullRequestId")?.as_u64()?;
    if number == 0 {
        return None;
    }
    let source_ref = row.get("sourceRefName")?.as_str()?;
    let head_branch = source_ref.strip_prefix("refs/heads/")?;
    let target_ref = row.get("targetRefName")?.as_str()?;
    let base_branch = target_ref.strip_prefix("refs/heads/")?;
    if head_branch.is_empty() || base_branch.is_empty() {
        return None;
    }
    let state = match row.get("status")?.as_str()? {
        "active" if row.get("isDraft")?.as_bool()? => PullRequestState::Draft,
        "active" => PullRequestState::Open,
        "completed" => PullRequestState::Merged,
        "abandoned" => PullRequestState::Closed,
        _ => return None,
    };
    let updated_at_epoch_ms = ["creationDate", "closedDate", "sourceCommitDate"]
        .into_iter()
        .filter_map(|field| row.get(field).and_then(Value::as_str))
        .filter_map(parse_rfc3339_epoch_ms)
        .max()?;
    let url = format!(
        "https://{AZURE_HOST}/{}/{}/_git/{}/pullrequest/{number}",
        query.repository.organization,
        encode_path_segment(&repository_project),
        encode_path_segment(&repository_name),
    );
    if url.len() > 2048 {
        return None;
    }
    Some(PullRequestSummary {
        provider: GitHostProvider::AzureDevOps,
        host: AZURE_HOST.into(),
        repository_owner: query.repository.organization.clone(),
        repository_project: Some(repository_project),
        repository_name,
        number,
        title: bounded_text(row.get("title")?.as_str()?, 512),
        url,
        state,
        base_branch: bounded_text(base_branch, 1024),
        head_branch: bounded_text(head_branch, 1024),
        head_repository_owner: query.repository.organization.clone(),
        head_repository_project: Some(head_repository_project),
        head_repository_name,
        checks: CheckState::Unknown,
        review: map_azure_review(row.get("reviewers")?),
        mergeability: match row.get("mergeStatus").and_then(Value::as_str) {
            Some("succeeded") => Mergeability::Mergeable,
            Some("conflicts") => Mergeability::Conflicting,
            Some("notSet" | "queued" | "rejectedByPolicy" | "failure") | None => {
                Mergeability::Unknown
            }
            Some(_) => return None,
        },
        updated_at_epoch_ms,
    })
}

fn map_azure_review(value: &Value) -> ReviewState {
    let Some(reviewers) = value.as_array() else {
        return ReviewState::Unknown;
    };
    if reviewers.is_empty() {
        return ReviewState::Unknown;
    }
    let mut saw_zero = false;
    for reviewer in reviewers {
        if reviewer.get("isRequired").and_then(Value::as_bool) != Some(true) {
            return ReviewState::Unknown;
        }
        match reviewer.get("vote").and_then(Value::as_i64) {
            Some(-10 | -5) => return ReviewState::ChangesRequested,
            Some(0) => saw_zero = true,
            Some(5 | 10) => {}
            _ => return ReviewState::Unknown,
        }
    }
    if saw_zero {
        ReviewState::ReviewRequired
    } else {
        ReviewState::Approved
    }
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

pub fn module_name() -> &'static str {
    "providers"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_cli_fixture_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "termloop-providers-cli-{label}-{}-{}",
            std::process::id(),
            termloop_platform::current_epoch_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    /// The fixture is a shebang script on Unix and a `.cmd` shim on Windows,
    /// so on Windows this proves the resolver's `cmd.exe` wrapper composition
    /// produces a runnable request for a CLI that has no `.exe` (the real
    /// `az.cmd` shape); a bare `CommandRequest::new("az")` cannot start it.
    #[test]
    fn provider_cli_requests_resolve_path_shims_into_runnable_commands() {
        let directory = provider_cli_fixture_directory("resolved");
        for (program, request_for) in [
            (
                "gh",
                github_cli_request
                    as fn(
                        termloop_platform::LaunchEnvironment,
                    ) -> Result<CommandRequest, ProviderFailure>,
            ),
            ("az", azure_cli_request),
        ] {
            termloop_platform::test_support::write_cli_fixture(
                &directory,
                program,
                "#!/bin/sh\nprintf 'args=%s gh_pager=(%s) pager=(%s)\\n' \"$*\" \"$GH_PAGER\" \"$PAGER\"\n",
                "@echo off\r\necho args=%* gh_pager=(%GH_PAGER%) pager=(%PAGER%)\r\n",
            )
            .unwrap();
            let environment = termloop_platform::LaunchEnvironment::os_baseline()
                .with_explicit("PATH", &directory);
            let request = request_for(environment).unwrap();
            let outcome = termloop_platform::run_command(
                request
                    .args(["first-argument", "second-argument"])
                    .timeout(Duration::from_secs(20)),
            )
            .unwrap();
            assert!(outcome.success(), "{program}: {outcome:?}");
            let stdout = String::from_utf8_lossy(&outcome.stdout);
            assert!(
                stdout.contains("args=first-argument second-argument"),
                "{program}: appended arguments must follow the wrapper prefix: {stdout}"
            );
            assert!(
                !stdout.contains("cat"),
                "{program}: pager values must never name a spawnable binary: {stdout}"
            );
        }
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn missing_provider_cli_is_the_typed_unavailable_state() {
        let directory = provider_cli_fixture_directory("missing");
        let environment =
            termloop_platform::LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);
        assert_eq!(
            github_cli_request(environment.clone()).err(),
            Some(ProviderFailure::ProviderUnavailable)
        );
        assert_eq!(
            azure_cli_request(environment).err(),
            Some(ProviderFailure::ProviderUnavailable)
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn remote_parser_accepts_github_transports_and_rejects_authority() {
        for value in [
            b"https://github.com/acme/widget.git".as_slice(),
            b"ssh://git@github.com/acme/widget.git",
            b"ssh://github.com/acme/widget.git",
            b"git@github.com:acme/widget.git",
        ] {
            assert_eq!(
                parse_github_remote(value).unwrap(),
                GitHubRepository {
                    owner: "acme".into(),
                    name: "widget".into()
                }
            );
        }
        for value in [
            b"https://token@github.com/acme/widget.git".as_slice(),
            b"https://github.com.evil/acme/widget.git",
            b"https://github.com/acme/widget.git?token=secret",
            b"file:///tmp/widget",
            b"https://github.com/../widget.git",
        ] {
            assert!(parse_github_remote(value).is_err());
        }
    }

    #[test]
    fn rate_limit_reset_is_parsed_and_clamped() {
        let queries = vec![PullRequestQuery {
            repository: GitHubRepository {
                owner: "acme".into(),
                name: "widget".into(),
            },
            head_branch: "main".into(),
        }];
        let response = serde_json::to_vec(&json!({
            "data": {
                "q0": null,
                "rateLimit": {"remaining": 0, "resetAt": "1970-01-01T00:02:01Z"}
            }
        }))
        .unwrap();
        let result = parse_graphql_response(&queries, &response, 1_000).unwrap();
        assert_eq!(result[0].failure, Some(ProviderFailure::RateLimited));
        assert_eq!(result[0].retry_after_epoch_ms, Some(121_000));
    }

    #[test]
    fn graphql_parser_keeps_multiple_matches_and_never_trusts_response_url() {
        let queries = vec![PullRequestQuery {
            repository: GitHubRepository {
                owner: "acme".into(),
                name: "widget".into(),
            },
            head_branch: "review/42".into(),
        }];
        let node = json!({
            "number": 7,
            "title": "Safe title",
            "url": "https://evil.test/token",
            "state": "OPEN",
            "isDraft": false,
            "baseRefName": "main",
            "headRefName": "review/42",
            "headRepository": {"nameWithOwner": "acme/widget"},
            "updatedAt": "2026-08-10T10:00:00Z",
            "mergeable": "MERGEABLE",
            "reviewDecision": "APPROVED",
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS"}}}]}
        });
        let response = serde_json::to_vec(&json!({
            "data": {"q0": {"isFork": false, "pullRequests": {"pageInfo": {"hasNextPage": false}, "nodes": [node.clone(), node]}}}
        }))
        .unwrap();
        let result = parse_graphql_response(&queries, &response, 1_000).unwrap();
        assert_eq!(result[0].matches.len(), 1);
        assert_eq!(
            result[0].matches[0].url,
            "https://github.com/acme/widget/pull/7"
        );
        assert_eq!(result[0].matches[0].checks, CheckState::Passing);
    }

    #[test]
    fn graphql_body_has_fixed_endpoint_shape_and_bounds() {
        let body = build_graphql_body(&[PullRequestQuery {
            repository: GitHubRepository {
                owner: "acme".into(),
                name: "widget".into(),
            },
            head_branch: "feature\"quoted".into(),
        }])
        .unwrap();
        assert!(body.len() < MAX_STDIN);
        let value: Value = serde_json::from_slice(&body).unwrap();
        let query = value.get("query").and_then(Value::as_str).unwrap();
        assert!(query.contains("feature\\\"quoted"));
        assert!(!query.contains("token"));
        assert!(query.contains("first:17"));
        assert!(query.contains("pageInfo{hasNextPage}"));
    }

    #[test]
    fn incomplete_deleted_head_and_seventeenth_match_are_never_authoritative() {
        let queries = vec![PullRequestQuery {
            repository: GitHubRepository {
                owner: "acme".into(),
                name: "widget".into(),
            },
            head_branch: "feature".into(),
        }];
        let node = |number| {
            json!({
                "number": number,
                "title": "PR",
                "state": "OPEN",
                "isDraft": false,
                "baseRefName": "main",
                "headRefName": "feature",
                "headRepository": {"nameWithOwner": "acme/widget"},
                "updatedAt": "2026-08-10T10:00:00Z",
                "mergeable": "MERGEABLE",
                "reviewDecision": "APPROVED",
                "commits": {"nodes": []}
            })
        };
        let nodes = (1..=17).map(node).collect::<Vec<_>>();
        let response = serde_json::to_vec(&json!({
            "data": {"q0": {
                "isFork": false,
                "pullRequests": {"pageInfo": {"hasNextPage": false}, "nodes": nodes}
            }}
        }))
        .unwrap();
        let result = parse_graphql_response(&queries, &response, 1_000).unwrap();
        assert!(result[0].truncated);
        assert_eq!(result[0].matches.len(), 16);

        let mut deleted = node(1);
        deleted["headRepository"] = Value::Null;
        let response = serde_json::to_vec(&json!({
            "data": {"q0": {
                "isFork": false,
                "pullRequests": {"pageInfo": {"hasNextPage": false}, "nodes": [deleted]}
            }}
        }))
        .unwrap();
        let result = parse_graphql_response(&queries, &response, 1_000).unwrap();
        assert!(result[0].truncated);
        assert!(result[0].matches.is_empty());
    }

    #[test]
    fn graphql_alias_error_does_not_degrade_its_sibling() {
        let queries = ["one", "two"].map(|head_branch| PullRequestQuery {
            repository: GitHubRepository {
                owner: "acme".into(),
                name: "widget".into(),
            },
            head_branch: head_branch.into(),
        });
        let response = serde_json::to_vec(&json!({
            "data": {
                "q0": {"isFork": false, "pullRequests": {"pageInfo": {"hasNextPage": false}, "nodes": []}},
                "q1": null
            },
            "errors": [{"type": "FORBIDDEN", "message": "raw secret", "path": ["q1"]}]
        }))
        .unwrap();
        let results = parse_graphql_response(&queries, &response, 1_000).unwrap();
        assert_eq!(results[0].failure, None);
        assert_eq!(results[1].failure, Some(ProviderFailure::Unauthorized));
    }

    #[test]
    fn provider_debug_does_not_expose_registry_path() {
        let client = GitHubClient::new(std::path::Path::new("/private/provider-processes"));
        assert!(!format!("{client:?}").contains("/private"));
    }

    #[test]
    fn azure_remote_parser_accepts_modern_forms_and_rejects_credentials() {
        let expected = AzureRepository {
            organization: "fiber-teams".into(),
            project: "Fiber Tests".into(),
            name: "Widget".into(),
        };
        for remote in [
            b"https://dev.azure.com/fiber-teams/Fiber%20Tests/_git/Widget".as_slice(),
            b"https://fiber-teams@dev.azure.com/fiber-teams/Fiber%20Tests/_git/Widget",
            b"ssh://git@ssh.dev.azure.com/v3/fiber-teams/Fiber%20Tests/Widget",
            b"git@ssh.dev.azure.com:v3/fiber-teams/Fiber%20Tests/Widget",
        ] {
            assert_eq!(parse_azure_remote(remote).unwrap(), expected);
        }
        assert_eq!(
            parse_azure_remote(b"https://dev.azure.com/fiber-teams/Fiber%20Tests/_git/Widget.git")
                .unwrap()
                .name,
            "Widget.git"
        );
        for remote in [
            b"https://other@dev.azure.com/fiber-teams/Fiber/_git/Widget".as_slice(),
            b"https://fiber-teams:secret@dev.azure.com/fiber-teams/Fiber/_git/Widget",
            b"https://dev.azure.com/fiber-teams/Fiber%2FTests/_git/Widget",
            b"https://dev.azure.com/fiber-teams/.hidden/_git/Widget",
            b"https://dev.azure.com.evil/fiber-teams/Fiber/_git/Widget",
        ] {
            assert!(parse_azure_remote(remote).is_err(), "{remote:?}");
        }
    }

    fn azure_row(number: u64) -> Value {
        json!({
            "pullRequestId": number,
            "title": "Azure PR",
            "status": "active",
            "isDraft": false,
            "sourceRefName": "refs/heads/feature",
            "targetRefName": "refs/heads/main",
            "mergeStatus": "succeeded",
            "creationDate": "2026-08-10T10:00:00Z",
            "closedDate": null,
            "sourceCommitDate": "2026-08-10T10:01:00Z",
            "repository": {"name": "Widget", "project": "Fiber Tests"},
            "forkSource": {"repository": {"name": null, "project": null}},
            "reviewers": []
        })
    }

    #[test]
    fn azure_utc_offset_timestamps_normalize_to_the_same_instant_as_zulu() {
        assert_eq!(
            parse_rfc3339_epoch_ms("2026-08-10T15:28:16.618178+00:00"),
            parse_rfc3339_epoch_ms("2026-08-10T15:28:16.618178Z")
        );
        assert_eq!(
            parse_rfc3339_epoch_ms("2026-08-10T17:28:16.618178+02:00"),
            parse_rfc3339_epoch_ms("2026-08-10T15:28:16.618178Z")
        );
    }

    fn azure_query() -> AzurePullRequestQuery {
        AzurePullRequestQuery {
            repository: AzureRepository {
                organization: "fiber-teams".into(),
                project: "Fiber Tests".into(),
                name: "Widget".into(),
            },
            head_branch: "feature".into(),
        }
    }

    #[test]
    fn azure_scan_is_bounded_and_empty_required_reviewers_are_unknown() {
        let query = azure_query();
        let rows = (1..=17).map(azure_row).collect::<Vec<_>>();
        let scan = parse_azure_pull_request_scan(query, None, &serde_json::to_vec(&rows).unwrap())
            .unwrap();
        assert!(scan.truncated);
        assert_eq!(scan.pull_requests.len(), 16);
        assert_eq!(scan.pull_requests[0].provider, GitHostProvider::AzureDevOps);
        assert_eq!(scan.pull_requests[0].review, ReviewState::Unknown);
        assert_eq!(
            scan.pull_requests[0].url,
            "https://dev.azure.com/fiber-teams/Fiber%20Tests/_git/Widget/pullrequest/1"
        );
    }

    #[test]
    fn azure_incomplete_rows_never_become_authoritative() {
        let query = azure_query();
        let mut incomplete = azure_row(1);
        incomplete["sourceRefName"] = Value::Null;
        let scan = parse_azure_pull_request_scan(
            query,
            None,
            &serde_json::to_vec(&vec![incomplete]).unwrap(),
        )
        .unwrap();
        assert!(scan.incomplete);
        assert!(scan.pull_requests.is_empty());
    }

    #[test]
    fn azure_targeted_scan_discards_other_repositories_without_degrading() {
        let query = azure_query();
        let mut other_repository = azure_row(1);
        other_repository["repository"]["name"] = json!("Other");
        let scan = parse_azure_pull_request_scan(
            query,
            None,
            &serde_json::to_vec(&vec![other_repository]).unwrap(),
        )
        .unwrap();
        assert!(!scan.incomplete);
        assert!(!scan.truncated);
        assert!(scan.pull_requests.is_empty());
    }

    #[test]
    fn azure_closed_drafts_use_terminal_state_and_transient_discovery_retries() {
        let query = azure_query();
        for (status, expected) in [
            ("completed", PullRequestState::Merged),
            ("abandoned", PullRequestState::Closed),
        ] {
            let mut row = azure_row(1);
            row["status"] = json!(status);
            row["isDraft"] = json!(true);
            assert_eq!(
                normalize_azure_summary(&query, None, &row).unwrap().state,
                expected
            );
        }
        assert!(cacheable_discovery_failure(
            ProviderFailure::ProviderUnavailable
        ));
        assert!(!cacheable_discovery_failure(ProviderFailure::Timeout));
        assert!(!cacheable_discovery_failure(ProviderFailure::OutputLimit));
    }

    #[test]
    fn azure_known_target_is_normalized_and_must_share_organization() {
        let query = azure_query();
        let target = AzureRepository {
            organization: "FIBER-TEAMS".into(),
            project: "Parent Project".into(),
            name: "Parent".into(),
        };
        assert_eq!(
            normalize_known_target(&query, &target)
                .unwrap()
                .organization,
            "fiber-teams"
        );
        let other = AzureRepository {
            organization: "other".into(),
            ..target
        };
        assert!(normalize_known_target(&query, &other).is_err());
    }

    #[test]
    fn azure_query_is_branch_targeted_and_restricts_only_known_targets() {
        let query = azure_query();
        let arguments = azure_pull_request_arguments(&query, None);
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["--source-branch", "feature"])
        );
        assert!(arguments.windows(2).any(|pair| pair == ["--top", "17"]));
        assert!(!arguments.iter().any(|value| value == "--repository"));

        let target = AzureRepository {
            organization: "fiber-teams".into(),
            project: "Parent Project".into(),
            name: "Parent".into(),
        };
        let arguments = azure_pull_request_arguments(&query, Some(&target));
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["--project", "Parent Project"])
        );
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["--repository", "Parent"])
        );

        let metadata = azure_repository_arguments(&query);
        assert_eq!(&metadata[0..2], ["repos", "show"]);
        assert!(
            metadata
                .windows(2)
                .any(|pair| pair == ["--repository", "Widget"])
        );
    }

    #[test]
    fn azure_repository_relationship_proves_non_fork_or_exact_cross_project_parent() {
        let query = azure_query();
        let non_fork = json!({
            "name": "Widget",
            "project": "Fiber Tests",
            "parentRepository": {"name": null, "project": null}
        });
        assert_eq!(
            parse_azure_repository_relationship(&query, &serde_json::to_vec(&non_fork).unwrap())
                .unwrap(),
            AzureRepositoryRelationship::NonFork
        );
        let fork = json!({
            "name": "Widget",
            "project": "Fiber Tests",
            "parentRepository": {"name": "Upstream", "project": "Parent Project"}
        });
        assert_eq!(
            parse_azure_repository_relationship(&query, &serde_json::to_vec(&fork).unwrap())
                .unwrap(),
            AzureRepositoryRelationship::Fork(AzureRepository {
                organization: "fiber-teams".into(),
                project: "Parent Project".into(),
                name: "Upstream".into(),
            })
        );
        let incomplete = json!({
            "name": "Widget",
            "project": "Fiber Tests",
            "parentRepository": {"name": "Upstream", "project": null}
        });
        assert_eq!(
            parse_azure_repository_relationship(&query, &serde_json::to_vec(&incomplete).unwrap())
                .unwrap(),
            AzureRepositoryRelationship::Incomplete
        );
        let missing_relationship = json!({
            "name": "Widget",
            "project": "Fiber Tests"
        });
        assert_eq!(
            parse_azure_repository_relationship(
                &query,
                &serde_json::to_vec(&missing_relationship).unwrap()
            )
            .unwrap(),
            AzureRepositoryRelationship::Incomplete
        );
    }
}
