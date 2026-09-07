//! Server-user account setup, separate from agent Sessions and their history.
mod capabilities;
mod provider;
pub use capabilities::{
    discover as discover_agent_connection_capabilities,
    prepare as prepare_agent_connection_capabilities,
};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Codex,
    Claude,
}

impl Provider {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            _ => Err("Unsupported provider."),
        }
    }
    fn command(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

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

struct Job {
    owner: [u8; 32],
    operation: Arc<Mutex<Operation>>,
    cancel: Arc<AtomicBool>,
    input: mpsc::SyncSender<Vec<u8>>,
}
impl Drop for Job {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    agent_id: Provider,
    label: &'static str,
    installed: bool,
    version: Option<String>,
    auth_state: &'static str,
    install_supported: bool,
    busy: bool,
    operation: Option<Operation>,
}

/// At most one operation per provider and OS user. A requester is derived from
/// its authenticated credential, never a caller-supplied device identifier.
pub struct AgentConnections {
    jobs: Mutex<HashMap<Provider, Job>>,
    registry: PathBuf,
}

impl AgentConnections {
    pub fn new(registry: PathBuf) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            registry,
        }
    }

    pub fn status_list(&self, credential: &str) -> Vec<Status> {
        [Provider::Codex, Provider::Claude]
            .into_iter()
            .map(|provider| {
                let (busy, operation) = {
                    let jobs = self.jobs.lock().unwrap();
                    let job = jobs.get(&provider);
                    (
                        job.is_some_and(|job| job.operation.lock().unwrap().active()),
                        job.filter(|job| job.owner == owner(credential))
                            .map(|job| job.operation.lock().unwrap().clone()),
                    )
                };
                let mut status = provider::status(provider, !busy);
                status.busy = busy;
                status.operation = operation;
                status
            })
            .collect()
    }

    pub fn start(
        &self,
        provider: Provider,
        action: Action,
        credential: &str,
    ) -> Result<Operation, &'static str> {
        let mut jobs = self.jobs.lock().unwrap();
        if let Some(job) = jobs.get(&provider) {
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
        let cancel = Arc::new(AtomicBool::new(false));
        let (input, receiver) = mpsc::sync_channel(8);
        let job = Job {
            owner: owner(credential),
            operation: snapshot.clone(),
            cancel: cancel.clone(),
            input: input.clone(),
        };
        let registry = self.registry.clone();
        std::thread::Builder::new()
            .name("agent-account-setup".into())
            .spawn(move || {
                provider::run(
                    provider, action, snapshot, cancel, input, receiver, registry,
                );
            })
            .map_err(|_| "Could not start account setup.")?;
        jobs.insert(provider, job);
        Ok(operation)
    }

    pub fn operation(
        &self,
        provider: Provider,
        id: &str,
        credential: &str,
    ) -> Result<Operation, &'static str> {
        let jobs = self.jobs.lock().unwrap();
        let job = owned_job(&jobs, provider, id, credential)?;
        Ok(job.operation.lock().unwrap().clone())
    }

    pub fn cancel(
        &self,
        provider: Provider,
        id: &str,
        credential: &str,
    ) -> Result<Operation, &'static str> {
        let jobs = self.jobs.lock().unwrap();
        let job = owned_job(&jobs, provider, id, credential)?;
        job.cancel.store(true, Ordering::Release);
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
        let job = owned_job(&jobs, provider, id, credential)?;
        let mut operation = job.operation.lock().unwrap();
        if !operation.active() || !operation.accepts_code || job.cancel.load(Ordering::Acquire) {
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
    jobs: &'a HashMap<Provider, Job>,
    provider: Provider,
    id: &str,
    credential: &str,
) -> Result<&'a Job, &'static str> {
    jobs.get(&provider)
        .filter(|job| {
            job.owner == owner(credential) && job.operation.lock().unwrap().operation_id == id
        })
        .ok_or("This setup attempt is unavailable or belongs to another connection.")
}
