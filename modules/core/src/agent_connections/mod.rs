//! Server-user account setup, separate from agent Sessions and their history.
mod capabilities;
mod provider;
mod usage;
pub use capabilities::{
    discover as discover_agent_connection_capabilities,
    prepare as prepare_agent_connection_capabilities,
};
pub use usage::{Identity, Usage, UsageState};
#[cfg(test)]
mod tests;

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use termloop_agents::AgentAccountContext;

pub use termloop_domain::AgentAccountProvider as Provider;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Install,
    SignIn,
    SignOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Starting,
    Installing,
    AwaitingBrowser,
    AwaitingCode,
    Succeeded,
    Failed,
    Cancelled,
    Expired,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub agent_id: Provider,
    pub account_id: String,
    pub operation_id: String,
    pub action: Action,
    pub phase: Phase,
    pub verification_url: Option<String>,
    pub user_code: Option<String>,
    pub accepts_code: bool,
    pub message: String,
    pub expires_at_epoch_ms: u64,
}

impl Operation {
    fn active(&self) -> bool {
        matches!(
            self.phase,
            Phase::Starting | Phase::Installing | Phase::AwaitingBrowser | Phase::AwaitingCode
        )
    }
    fn finish(&mut self, phase: Phase, message: &str) {
        self.phase = phase;
        self.message = message.into();
        self.verification_url = None;
        self.user_code = None;
        self.accepts_code = false;
    }
}

#[derive(Clone, Default)]
struct SetupControl {
    cancel: Arc<AtomicBool>,
    unreaped: Arc<Mutex<Option<termloop_platform::ManagedProcess>>>,
}

struct Job {
    owner: [u8; 32],
    operation: Arc<Mutex<Operation>>,
    control: SetupControl,
    input: mpsc::SyncSender<Vec<u8>>,
}
impl Drop for Job {
    fn drop(&mut self) {
        self.control.cancel.store(true, Ordering::Release);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    agent_id: Provider,
    account_id: String,
    label: &'static str,
    installed: bool,
    version: Option<String>,
    auth_state: &'static str,
    install_supported: bool,
    busy: bool,
    operation: Option<Operation>,
    identity: Option<Identity>,
}

impl Status {
    pub fn installation_changed(
        &self,
        capabilities: &[crate::DiscoveredAgentCapabilities],
    ) -> bool {
        capabilities
            .iter()
            .find(|item| item.agent_id == self.agent_id.command())
            .is_none_or(|item| {
                self.installed != item.available
                    || (self.installed && self.version.is_some() && self.version != item.version)
            })
    }
}

/// At most one operation per account; installation reserves the provider. A requester is derived from
/// its authenticated credential, never a caller-supplied device identifier.
pub struct AgentConnections {
    jobs: Mutex<HashMap<(Provider, String), Job>>,
    registry: PathBuf,
    usage: Mutex<HashMap<(Provider, String), Usage>>,
}

/// Provider usage endpoints are rate limited themselves; reuse a recent read.
const USAGE_CACHE_MS: u64 = 60_000;

impl AgentConnections {
    pub fn new(registry: PathBuf) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            registry,
            usage: Mutex::new(HashMap::new()),
        }
    }

    pub fn status_list(&self, accounts: &[AgentAccountContext], credential: &str) -> Vec<Status> {
        accounts
            .iter()
            .map(|account| {
                let provider =
                    Provider::parse(&account.agent_id).expect("validated account provider");
                let (busy, operation) = {
                    let jobs = self.jobs.lock().unwrap();
                    let job = jobs.get(&(provider, account.account_id.clone()));
                    let busy = jobs.iter().any(|((p, id), job)| {
                        *p == provider
                            && (id == &account.account_id
                                || job.operation.lock().unwrap().action == Action::Install)
                            && job_busy(job)
                    });
                    (
                        busy,
                        job.filter(|job| job.owner == owner(credential))
                            .map(|job| job.operation.lock().unwrap().clone()),
                    )
                };
                let mut status = provider::status(account, !busy);
                if provider == Provider::Codex && status.auth_state == "signedIn" {
                    status.identity = usage::codex_identity(account, &self.registry);
                }
                status.busy = busy;
                status.operation = operation;
                status
            })
            .collect()
    }

    pub fn start(
        &self,
        account: AgentAccountContext,
        action: Action,
        credential: &str,
    ) -> Result<Operation, &'static str> {
        let provider = Provider::parse(&account.agent_id)?;
        let key = (provider, account.account_id.clone());
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.iter().any(|((p, id), job)| {
            *p == provider
                && id != &account.account_id
                && job_busy(job)
                && (action == Action::Install
                    || job.operation.lock().unwrap().action == Action::Install)
        }) {
            return Err("Finish account setup before installing or updating this provider.");
        }
        if let Some(job) = jobs.get(&key) {
            if job.control.unreaped.lock().unwrap().is_some() {
                return Err(
                    "Restart this server to recover an unfinished provider process before starting setup again.",
                );
            }
            let operation = job.operation.lock().unwrap();
            if operation.active() {
                return if job.owner == owner(credential) && operation.action == action {
                    Ok(operation.clone())
                } else {
                    Err("Another setup operation is already running for this server account.")
                };
            }
        }
        let operation = Operation {
            agent_id: provider,
            account_id: account.account_id.clone(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            action,
            phase: Phase::Starting,
            verification_url: None,
            user_code: None,
            accepts_code: false,
            message: "Preparing…".into(),
            expires_at_epoch_ms: termloop_platform::current_epoch_ms() + 15 * 60 * 1000,
        };
        let snapshot = Arc::new(Mutex::new(operation.clone()));
        let control = SetupControl::default();
        let (input, receiver) = mpsc::sync_channel(8);
        let job = Job {
            owner: owner(credential),
            operation: snapshot.clone(),
            control: control.clone(),
            input: input.clone(),
        };
        let registry = self.registry.clone();
        std::thread::Builder::new()
            .name("agent-account-setup".into())
            .spawn(move || {
                provider::run(
                    account, action, snapshot, control, input, receiver, registry,
                );
            })
            .map_err(|_| "Could not start account setup.")?;
        jobs.insert(key, job);
        Ok(operation)
    }

    /// Identity and limits for each account, read in parallel. A read newer
    /// than the cache window is reused unless `refresh` asks for a new one.
    pub fn usage_list(&self, accounts: &[AgentAccountContext], refresh: bool) -> Vec<Usage> {
        let now = termloop_platform::current_epoch_ms();
        std::thread::scope(|scope| {
            let reads = accounts
                .iter()
                .map(|account| {
                    let key = (
                        Provider::parse(&account.agent_id).expect("validated account provider"),
                        account.account_id.clone(),
                    );
                    let cached = self
                        .usage
                        .lock()
                        .unwrap()
                        .get(&key)
                        .filter(|usage| {
                            !refresh
                                && now.saturating_sub(usage.fetched_at_epoch_ms) < USAGE_CACHE_MS
                        })
                        .cloned();
                    match cached {
                        Some(usage) => Err(usage),
                        None => Ok((key, scope.spawn(|| self.read_usage(account)))),
                    }
                })
                .collect::<Vec<_>>();
            reads
                .into_iter()
                .map(|read| match read {
                    Err(cached) => cached,
                    Ok((key, handle)) => {
                        let usage = handle.join().expect("usage read thread");
                        self.usage.lock().unwrap().insert(key, usage.clone());
                        usage
                    }
                })
                .collect()
        })
    }

    fn read_usage(&self, account: &AgentAccountContext) -> Usage {
        let provider = Provider::parse(&account.agent_id).expect("validated account provider");
        if self.account_busy(provider, &account.account_id) {
            return usage::unread(
                account,
                UsageState::Unavailable,
                "Account setup is in progress",
            );
        }
        let status = provider::status(account, true);
        match status.auth_state {
            "signedOut" => usage::unread(account, UsageState::SignedOut, "Not signed in"),
            _ if !status.installed => usage::unread(
                account,
                UsageState::Unavailable,
                "The provider CLI is not installed",
            ),
            _ => usage::usage(account, status.identity, &self.registry),
        }
    }

    /// Whether a setup operation still owns this account or its provider-wide install.
    pub fn account_busy(&self, provider: Provider, account_id: &str) -> bool {
        self.jobs.lock().unwrap().iter().any(|((p, id), job)| {
            *p == provider
                && (id == account_id || job.operation.lock().unwrap().action == Action::Install)
                && job_busy(job)
        })
    }

    /// Signs a removed account out and disposes of its private directory. Runs
    /// after the record is gone, so a failure leaves only unreachable files.
    pub fn discard(&self, account: &AgentAccountContext) -> Result<(), &'static str> {
        let provider = Provider::parse(&account.agent_id)?;
        self.jobs
            .lock()
            .unwrap()
            .remove(&(provider, account.account_id.clone()));
        provider::discard(account)
    }

    pub fn operation(
        &self,
        provider: Provider,
        account_id: &str,
        id: &str,
        credential: &str,
    ) -> Result<Operation, &'static str> {
        let jobs = self.jobs.lock().unwrap();
        let job = owned_job(&jobs, provider, account_id, id, credential)?;
        Ok(job.operation.lock().unwrap().clone())
    }

    pub fn cancel(
        &self,
        provider: Provider,
        account_id: &str,
        id: &str,
        credential: &str,
    ) -> Result<Operation, &'static str> {
        let jobs = self.jobs.lock().unwrap();
        let job = owned_job(&jobs, provider, account_id, id, credential)?;
        job.control.cancel.store(true, Ordering::Release);
        // Keep the reservation until the worker has reaped its child tree.
        let mut operation = job.operation.lock().unwrap();
        if operation.active() {
            operation.message = "Cancelling…".into();
            operation.verification_url = None;
            operation.user_code = None;
            operation.accepts_code = false;
        }
        Ok(operation.clone())
    }

    pub fn submit_code(
        &self,
        provider: Provider,
        account_id: &str,
        id: &str,
        credential: &str,
        code: &str,
    ) -> Result<Operation, &'static str> {
        if code.is_empty()
            || code.len() > 2048
            || code.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err("Paste only the code from the provider’s sign-in page.");
        }
        let jobs = self.jobs.lock().unwrap();
        let job = owned_job(&jobs, provider, account_id, id, credential)?;
        let mut operation = job.operation.lock().unwrap();
        if !operation.active()
            || !operation.accepts_code
            || job.control.cancel.load(Ordering::Acquire)
        {
            return Err("This sign-in attempt is not waiting for a code.");
        }
        job.input
            .try_send(format!("{code}\n").into_bytes())
            .map_err(|_| "Sign-in input is unavailable.")?;
        operation.accepts_code = false;
        operation.message = "Checking the authorization code…".into();
        Ok(operation.clone())
    }
}

fn owner(credential: &str) -> [u8; 32] {
    Sha256::digest(credential.as_bytes()).into()
}
fn owned_job<'a>(
    jobs: &'a HashMap<(Provider, String), Job>,
    provider: Provider,
    account_id: &str,
    id: &str,
    credential: &str,
) -> Result<&'a Job, &'static str> {
    jobs.get(&(provider, account_id.into()))
        .filter(|job| {
            job.owner == owner(credential) && job.operation.lock().unwrap().operation_id == id
        })
        .ok_or("This setup attempt is unavailable or belongs to another connection.")
}

fn job_busy(job: &Job) -> bool {
    job.operation.lock().unwrap().active() || job.control.unreaped.lock().unwrap().is_some()
}
