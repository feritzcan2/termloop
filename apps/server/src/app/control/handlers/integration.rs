//! Host-level integration status (`integration.statusList`) and the daemon-held
//! Azure DevOps PAT (`integration.azureDevOpsTokenSet`).
//!
//! CLI probes are blocking provider work: they run on blocking workers,
//! bounded by a timeout, and never while the serialized core lock is held.
//! Jira status is derived from existing Task Source runtime/credential state
//! without new network work. Credentials never appear in results or logs.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};
use termloop_contract::current::{
    IntegrationAzureDevOpsTokenSetParams, IntegrationCapability, IntegrationCapabilityDto,
    IntegrationConnectionState, IntegrationCredentialSource, IntegrationProvider,
    IntegrationStatusDto, IntegrationStatusListParams,
};
use termloop_core::{
    AzureDevOpsCredential, CoreError, IntegrationProbe, IntegrationProbeCredential,
    IntegrationProbeState, TaskSourceFailure,
};
use termloop_platform::{SecureCredentialError, SecureCredentialKey, SecureSecret};
use tokio::time::{Duration, Instant};

use super::super::super::{AppState, current_epoch_ms};
use super::super::task_source::{
    TaskSourceCredentialPresence, credential_error, credential_presence,
};

const AZURE_DEVOPS_CREDENTIAL_SERVICE: &str = "dev.termloop.integration.azure-devops";
const AZURE_DEVOPS_CREDENTIAL_ACCOUNT: &str = "personal-access-token";
const GITHUB_TARGET: &str = "github.com";
const AZURE_DEVOPS_TARGET: &str = "dev.azure.com";
const PROBE_CACHE_TTL: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Outer bound on a blocking probe worker; the probe enforces its own deadline.
const PROBE_WORKER_TIMEOUT: Duration = Duration::from_secs(20);
const CREDENTIAL_STORE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_INTEGRATIONS: usize = 32;
const MAX_TARGET_BYTES: usize = 255;
const GIT_HOST_CAPABILITIES: [IntegrationCapability; 4] = [
    IntegrationCapability::PullRequests,
    IntegrationCapability::Checks,
    IntegrationCapability::Reviews,
    IntegrationCapability::MergeConflicts,
];

/// Disposable per-daemon cache of the CLI probes. The async mutex also
/// single-flights concurrent probes; it is never held with the core lock.
#[derive(Clone, Default)]
pub(in crate::app) struct IntegrationStatusCache {
    probes: Arc<tokio::sync::Mutex<Option<CachedProbes>>>,
}

struct CachedProbes {
    observed_at: Instant,
    github: IntegrationStatusDto,
    azure: IntegrationStatusDto,
}

impl CachedProbes {
    fn fresh(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.observed_at) < PROBE_CACHE_TTL
    }
}

pub(in crate::app) async fn integration_status_list(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<IntegrationStatusListParams>(params)
        .map_err(|_| CoreError::InvalidParams("integration.statusList".into()))?;
    let requested_at = Instant::now();
    let probes = async {
        let mut cache = state.integration_status.probes.lock().await;
        match cache.as_ref() {
            // A refresh that waited behind another one reuses its result.
            Some(cached)
                if cached.observed_at >= requested_at
                    || (!params.refresh && cached.fresh(Instant::now())) =>
            {
                (cached.github.clone(), cached.azure.clone())
            }
            _ => {
                let (github, azure) = tokio::join!(probe_github(state), probe_azure(state));
                *cache = Some(CachedProbes {
                    observed_at: Instant::now(),
                    github: github.clone(),
                    azure: azure.clone(),
                });
                (github, azure)
            }
        }
    };
    let ((github, azure), jira) = tokio::join!(probes, jira_statuses(state));
    let mut integrations = vec![github, azure];
    integrations.extend(jira);
    integrations.truncate(MAX_INTEGRATIONS);
    Ok(json!({ "integrations": integrations }))
}

pub(in crate::app) async fn integration_azure_devops_token_set(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<IntegrationAzureDevOpsTokenSetParams>(params)
        .map_err(|_| CoreError::InvalidParams("integration.azureDevOpsTokenSet".into()))?;
    let secret = match params.token {
        Some(token) => Some(token_secret(token)?),
        None => None,
    };
    // Serialize with status probes so a concurrent list cannot cache a probe
    // made with the replaced credential.
    let mut cache = state.integration_status.probes.lock().await;
    let key = credential_key();
    let store = state.secure_credentials.clone();
    let stored = tokio::time::timeout(
        CREDENTIAL_STORE_TIMEOUT,
        tokio::task::spawn_blocking(move || match secret {
            Some(secret) => store.set(&key, &secret).map(|()| Some(secret)),
            None => match store.delete(&key) {
                Ok(()) | Err(SecureCredentialError::NotFound) => Ok(None),
                Err(error) => Err(error),
            },
        }),
    )
    .await
    .map_err(|_| CoreError::Store("secure credential storage timed out".into()))?
    .map_err(|_| CoreError::Store("secure credential worker failed".into()))?
    .map_err(credential_error)?;
    state
        .azure_devops_credential
        .replace(stored)
        .map_err(|_| CoreError::InvalidParams("token".into()))?;
    let azure = probe_azure(state).await;
    if let Some(cached) = cache.as_mut() {
        cached.azure = azure.clone();
    }
    drop(cache);
    Ok(json!({ "status": azure }))
}

/// Loads a previously stored PAT once at daemon start. A missing or
/// unavailable store leaves the handle empty; Azure then reports its CLI state.
pub(in crate::app) async fn load_azure_devops_credential(state: AppState) {
    // Held so a token the user saves or removes meanwhile is never replaced by
    // the older stored one.
    let _probes = state.integration_status.probes.lock().await;
    let key = credential_key();
    let store = state.secure_credentials.clone();
    let loaded = tokio::time::timeout(
        CREDENTIAL_STORE_TIMEOUT,
        tokio::task::spawn_blocking(move || store.get(&key)),
    )
    .await;
    if let Ok(Ok(Ok(secret))) = loaded
        && state.azure_devops_credential.replace(Some(secret)).is_err()
    {
        tracing::warn!("stored Azure DevOps personal access token is malformed and was ignored");
    }
}

fn credential_key() -> SecureCredentialKey {
    SecureCredentialKey::new(
        AZURE_DEVOPS_CREDENTIAL_SERVICE,
        AZURE_DEVOPS_CREDENTIAL_ACCOUNT,
    )
    .expect("static Azure DevOps credential key is valid")
}

fn token_secret(token: String) -> Result<SecureSecret, CoreError> {
    let bytes = token.trim().as_bytes().to_vec();
    drop(token);
    if !termloop_core::valid_azure_devops_personal_access_token(&bytes) {
        return Err(CoreError::InvalidParams("token".into()));
    }
    SecureSecret::new(bytes).ok_or_else(|| CoreError::InvalidParams("token".into()))
}

async fn probe_github(state: &AppState) -> IntegrationStatusDto {
    let directory = state.provider_process_directory.clone();
    let probe = run_probe(move || termloop_core::probe_github_cli(&directory, PROBE_TIMEOUT)).await;
    git_host_status(IntegrationProvider::Github, GITHUB_TARGET, probe)
}

async fn probe_azure(state: &AppState) -> IntegrationStatusDto {
    let directory = state.provider_process_directory.clone();
    let credential: AzureDevOpsCredential = state.azure_devops_credential.clone();
    let probe = run_probe(move || {
        termloop_core::probe_azure_devops_cli(&directory, &credential, PROBE_TIMEOUT)
    })
    .await;
    git_host_status(IntegrationProvider::AzureDevOps, AZURE_DEVOPS_TARGET, probe)
}

async fn run_probe(
    probe: impl FnOnce() -> IntegrationProbe + Send + 'static,
) -> Option<IntegrationProbe> {
    match tokio::time::timeout(PROBE_WORKER_TIMEOUT, tokio::task::spawn_blocking(probe)).await {
        Ok(Ok(probe)) => Some(probe),
        Ok(Err(_)) => None,
        Err(_) => Some(IntegrationProbe::degraded(IntegrationProbeState::Timeout)),
    }
}

/// `None` means the probe worker itself failed, which is a typed `failed`.
fn git_host_status(
    provider: IntegrationProvider,
    target: &str,
    probe: Option<IntegrationProbe>,
) -> IntegrationStatusDto {
    let probe = probe.unwrap_or_else(|| IntegrationProbe::degraded(IntegrationProbeState::Failed));
    let state = probe_state(probe.state);
    let connected = state == IntegrationConnectionState::Connected;
    IntegrationStatusDto {
        provider,
        target: target.into(),
        state,
        account: probe.account.filter(|_| connected),
        credential_source: probe.credential.map(|credential| match credential {
            IntegrationProbeCredential::Cli => IntegrationCredentialSource::Cli,
            IntegrationProbeCredential::PersonalAccessToken => {
                IntegrationCredentialSource::PersonalAccessToken
            }
        }),
        capabilities: GIT_HOST_CAPABILITIES
            .into_iter()
            .map(|capability| IntegrationCapabilityDto {
                capability,
                available: connected,
            })
            .collect(),
        retry_after_epoch_ms: probe.retry_after_epoch_ms,
        checked_at_epoch_ms: current_epoch_ms(),
    }
}

fn probe_state(state: IntegrationProbeState) -> IntegrationConnectionState {
    match state {
        IntegrationProbeState::Connected => IntegrationConnectionState::Connected,
        IntegrationProbeState::NotInstalled => IntegrationConnectionState::NotInstalled,
        IntegrationProbeState::NotAuthenticated => IntegrationConnectionState::NotAuthenticated,
        IntegrationProbeState::ExtensionMissing => IntegrationConnectionState::ExtensionMissing,
        IntegrationProbeState::Offline => IntegrationConnectionState::Offline,
        IntegrationProbeState::RateLimited => IntegrationConnectionState::RateLimited,
        IntegrationProbeState::Timeout => IntegrationConnectionState::Timeout,
        IntegrationProbeState::Failed => IntegrationConnectionState::Failed,
    }
}

/// Secret-free facts about one Task Source that decide its site's status.
#[derive(Debug, Clone)]
struct JiraSourceFacts {
    site: String,
    enabled: bool,
    failure: Option<TaskSourceFailure>,
    retry_after_epoch_ms: Option<u64>,
    last_attempt_at_epoch_ms: Option<u64>,
    presence: TaskSourceCredentialPresence,
}

async fn jira_statuses(state: &AppState) -> Vec<IntegrationStatusDto> {
    let views = state.core.lock().await.all_task_source_views();
    let mut sources = Vec::with_capacity(views.len());
    for view in views {
        let Some(site) = jira_site_host(&view.configuration.site_base_url) else {
            continue;
        };
        sources.push(JiraSourceFacts {
            site,
            enabled: view.configuration.enabled,
            failure: view.failure,
            retry_after_epoch_ms: view.retry_after_epoch_ms,
            last_attempt_at_epoch_ms: view.last_attempt_at_epoch_ms,
            presence: credential_presence(state, &view.configuration.id).await,
        });
    }
    jira_site_statuses(sources, current_epoch_ms())
}

/// One entry per distinct site. Enabled sources decide the site state when
/// any exist; the least healthy of them wins so a broken source is visible.
fn jira_site_statuses(
    sources: Vec<JiraSourceFacts>,
    now_epoch_ms: u64,
) -> Vec<IntegrationStatusDto> {
    let mut sites = BTreeMap::<String, Vec<JiraSourceFacts>>::new();
    for source in sources {
        sites.entry(source.site.clone()).or_default().push(source);
    }
    sites
        .into_iter()
        .take(MAX_INTEGRATIONS - 2)
        .filter_map(|(site, sources)| {
            let any_enabled = sources.iter().any(|source| source.enabled);
            let (view, state) = sources
                .iter()
                .filter(|source| !any_enabled || source.enabled)
                .map(|source| (source, jira_source_state(source.presence, source.failure)))
                .min_by_key(|(_, state)| jira_state_rank(state))?;
            let connected = state == IntegrationConnectionState::Connected;
            Some(IntegrationStatusDto {
                provider: IntegrationProvider::Jira,
                target: site,
                retry_after_epoch_ms: (state == IntegrationConnectionState::RateLimited)
                    .then_some(view.retry_after_epoch_ms)
                    .flatten(),
                account: None,
                credential_source: connected.then_some(IntegrationCredentialSource::ApiToken),
                capabilities: vec![IntegrationCapabilityDto {
                    capability: IntegrationCapability::Issues,
                    available: connected,
                }],
                checked_at_epoch_ms: view.last_attempt_at_epoch_ms.unwrap_or(now_epoch_ms),
                state,
            })
        })
        .collect()
}

fn jira_source_state(
    presence: TaskSourceCredentialPresence,
    failure: Option<TaskSourceFailure>,
) -> IntegrationConnectionState {
    match presence {
        TaskSourceCredentialPresence::None => return IntegrationConnectionState::NotConfigured,
        TaskSourceCredentialPresence::Invalid => {
            return IntegrationConnectionState::NotAuthenticated;
        }
        TaskSourceCredentialPresence::Unavailable => return IntegrationConnectionState::Failed,
        TaskSourceCredentialPresence::Present => {}
    }
    match failure {
        None => IntegrationConnectionState::Connected,
        Some(TaskSourceFailure::CredentialsInvalid) => IntegrationConnectionState::NotAuthenticated,
        Some(TaskSourceFailure::CredentialsMissing) => IntegrationConnectionState::NotConfigured,
        Some(TaskSourceFailure::RateLimited) => IntegrationConnectionState::RateLimited,
        Some(TaskSourceFailure::ProviderUnavailable) => IntegrationConnectionState::Offline,
        Some(
            TaskSourceFailure::CredentialsUnavailable
            | TaskSourceFailure::ScopeInvalid
            | TaskSourceFailure::ResponseTooLarge
            | TaskSourceFailure::MalformedResponse,
        ) => IntegrationConnectionState::Failed,
    }
}

/// Lower is less healthy; `connected` ranks last.
fn jira_state_rank(state: &IntegrationConnectionState) -> u8 {
    match state {
        IntegrationConnectionState::NotAuthenticated => 0,
        IntegrationConnectionState::NotConfigured => 1,
        IntegrationConnectionState::Failed => 2,
        IntegrationConnectionState::RateLimited => 3,
        IntegrationConnectionState::Offline => 4,
        IntegrationConnectionState::Timeout => 5,
        IntegrationConnectionState::NotInstalled | IntegrationConnectionState::ExtensionMissing => {
            6
        }
        IntegrationConnectionState::Connected => 7,
    }
}

/// The host of a normalized `https://<site>` base URL, lowercased.
fn jira_site_host(site_base_url: &str) -> Option<String> {
    let rest = site_base_url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    let valid = !host.is_empty()
        && host.len() <= MAX_TARGET_BYTES
        && !host.contains('@')
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':'));
    valid.then_some(host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_contract::current as protocol;

    fn source(
        site: &str,
        enabled: bool,
        failure: Option<TaskSourceFailure>,
        presence: TaskSourceCredentialPresence,
    ) -> JiraSourceFacts {
        JiraSourceFacts {
            site: site.into(),
            enabled,
            failure,
            retry_after_epoch_ms: Some(99),
            last_attempt_at_epoch_ms: Some(7),
            presence,
        }
    }

    fn assert_valid_list(integrations: &[IntegrationStatusDto]) {
        let result = serde_json::to_value(protocol::IntegrationStatusListResult {
            integrations: integrations.to_vec(),
        })
        .unwrap();
        assert!(protocol::validate_method_result(
            "integration.statusList",
            &result
        ));
    }

    #[test]
    fn git_host_status_exposes_the_account_only_when_connected() {
        let connected = git_host_status(
            IntegrationProvider::Github,
            GITHUB_TARGET,
            Some(IntegrationProbe {
                state: IntegrationProbeState::Connected,
                account: Some("octo-cat".into()),
                credential: Some(IntegrationProbeCredential::Cli),
                retry_after_epoch_ms: None,
            }),
        );
        assert_eq!(connected.state, IntegrationConnectionState::Connected);
        assert_eq!(connected.account.as_deref(), Some("octo-cat"));
        assert_eq!(
            connected.credential_source,
            Some(IntegrationCredentialSource::Cli)
        );
        assert_eq!(connected.capabilities.len(), 4);
        assert!(
            connected
                .capabilities
                .iter()
                .all(|capability| capability.available)
        );

        let degraded = git_host_status(
            IntegrationProvider::AzureDevOps,
            AZURE_DEVOPS_TARGET,
            Some(IntegrationProbe {
                state: IntegrationProbeState::ExtensionMissing,
                account: Some("leak".into()),
                credential: Some(IntegrationProbeCredential::PersonalAccessToken),
                retry_after_epoch_ms: None,
            }),
        );
        assert_eq!(degraded.state, IntegrationConnectionState::ExtensionMissing);
        assert_eq!(degraded.account, None);
        // A saved PAT stays visible so it can be replaced or removed.
        assert_eq!(
            degraded.credential_source,
            Some(IntegrationCredentialSource::PersonalAccessToken)
        );
        assert!(
            degraded
                .capabilities
                .iter()
                .all(|capability| !capability.available)
        );

        let worker_failed = git_host_status(IntegrationProvider::Github, GITHUB_TARGET, None);
        assert_eq!(worker_failed.state, IntegrationConnectionState::Failed);
        assert_valid_list(&[connected, degraded, worker_failed]);
    }

    #[test]
    fn jira_state_is_derived_from_credential_and_refresh_state() {
        use IntegrationConnectionState as State;
        use TaskSourceCredentialPresence as Presence;
        assert_eq!(
            jira_source_state(Presence::None, None),
            State::NotConfigured
        );
        assert_eq!(
            jira_source_state(Presence::Invalid, None),
            State::NotAuthenticated
        );
        assert_eq!(
            jira_source_state(Presence::Unavailable, None),
            State::Failed
        );
        assert_eq!(jira_source_state(Presence::Present, None), State::Connected);
        assert_eq!(
            jira_source_state(Presence::Present, Some(TaskSourceFailure::RateLimited)),
            State::RateLimited
        );
        assert_eq!(
            jira_source_state(
                Presence::Present,
                Some(TaskSourceFailure::ProviderUnavailable)
            ),
            State::Offline
        );
        assert_eq!(
            jira_source_state(
                Presence::Present,
                Some(TaskSourceFailure::CredentialsInvalid)
            ),
            State::NotAuthenticated
        );
    }

    #[test]
    fn jira_sites_are_deduplicated_and_the_least_healthy_enabled_source_wins() {
        let statuses = jira_site_statuses(
            vec![
                source(
                    "acme.atlassian.net",
                    true,
                    None,
                    TaskSourceCredentialPresence::Present,
                ),
                source(
                    "acme.atlassian.net",
                    true,
                    Some(TaskSourceFailure::RateLimited),
                    TaskSourceCredentialPresence::Present,
                ),
                // A disabled source without credentials does not degrade a
                // site that has enabled sources.
                source(
                    "acme.atlassian.net",
                    false,
                    None,
                    TaskSourceCredentialPresence::None,
                ),
                source(
                    "beta.atlassian.net",
                    true,
                    None,
                    TaskSourceCredentialPresence::Present,
                ),
            ],
            1_000,
        );
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].target, "acme.atlassian.net");
        assert_eq!(statuses[0].state, IntegrationConnectionState::RateLimited);
        assert_eq!(statuses[0].retry_after_epoch_ms, Some(99));
        assert_eq!(statuses[0].credential_source, None);
        assert_eq!(statuses[1].state, IntegrationConnectionState::Connected);
        assert_eq!(statuses[1].retry_after_epoch_ms, None);
        assert_eq!(
            statuses[1].credential_source,
            Some(IntegrationCredentialSource::ApiToken)
        );
        assert_eq!(statuses[1].checked_at_epoch_ms, 7);
        assert_eq!(
            statuses[1].capabilities[0].capability,
            IntegrationCapability::Issues
        );
        assert!(statuses[1].capabilities[0].available);
        assert_valid_list(&statuses);
        assert!(jira_site_statuses(Vec::new(), 1).is_empty());
    }

    #[test]
    fn jira_site_host_accepts_only_a_plain_https_host() {
        assert_eq!(
            jira_site_host("https://Acme.atlassian.net"),
            Some("acme.atlassian.net".into())
        );
        assert_eq!(
            jira_site_host("https://acme.atlassian.net/"),
            Some("acme.atlassian.net".into())
        );
        assert_eq!(jira_site_host("http://acme.atlassian.net"), None);
        assert_eq!(jira_site_host("https://user@acme.atlassian.net"), None);
        assert_eq!(jira_site_host("https://"), None);
    }

    #[test]
    fn token_secret_rejects_malformed_values() {
        assert!(token_secret("pat-value".into()).is_ok());
        assert!(token_secret("  pat-value \n".into()).is_ok());
        assert!(token_secret("has space".into()).is_err());
        assert!(token_secret("   ".into()).is_err());
    }

    #[tokio::test]
    async fn probe_cache_is_fresh_only_within_its_ttl() {
        let dto = git_host_status(IntegrationProvider::Github, GITHUB_TARGET, None);
        let now = Instant::now();
        let cached = CachedProbes {
            observed_at: now,
            github: dto.clone(),
            azure: dto,
        };
        assert!(cached.fresh(now));
        assert!(cached.fresh(now + PROBE_CACHE_TTL - Duration::from_millis(1)));
        assert!(!cached.fresh(now + PROBE_CACHE_TTL));
    }
}
