use std::path::Path;
use std::sync::mpsc::Sender;

use crate::session_launch::{AgentMcpRole, AgentResumePreparationError, AgentResumeReapError};
use crate::{AgentObservationTransport, AgentRuntimeSignal, McpAuthorizer};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy)]
pub(crate) enum ProviderRuntimeMode {
    OptionalObservation,
    Resume,
}

pub(crate) struct ProviderRuntimePreparation<'a> {
    pub agent_id: &'a str,
    pub session_id: &'a str,
    pub runtime_epoch: u64,
    pub cwd: &'a str,
    pub managed_worktree: bool,
    pub account: Option<&'a termloop_agents::AgentAccountContext>,
    pub transport: Option<&'a AgentObservationTransport>,
    pub mode: ProviderRuntimeMode,
    pub authorizer: &'a McpAuthorizer,
    pub mcp: Option<(&'a str, &'a AgentMcpRole)>,
    pub signals: &'a mut Option<Sender<AgentRuntimeSignal>>,
    pub launch: Option<&'a mut termloop_invocation::LaunchPayload>,
    pub history: Option<&'a str>,
}

#[derive(Debug)]
pub(crate) enum ProviderRuntimePreparationError {
    AccountUnavailable,
    Runtime(AgentResumePreparationError),
    EndpointBindingFailed,
}

struct ProvisionalMcpAdmission {
    authorizer: McpAuthorizer,
    session_id: String,
    runtime_epoch: u64,
    token: String,
}

impl Drop for ProvisionalMcpAdmission {
    fn drop(&mut self) {
        self.authorizer
            .remove_provisional(&self.session_id, self.runtime_epoch, &self.token);
    }
}

/// Owns the provider process and its transport-only credential until the
/// feature commits or explicitly aborts. All preparation/abort work is blocking
/// and must run outside the serialized Core lock.
#[derive(Default)]
pub(crate) struct PreparedProviderRuntime {
    runtime: Option<CodexRuntime>,
    provisional: Option<ProvisionalMcpAdmission>,
}

impl PreparedProviderRuntime {
    pub(crate) fn codex(&self) -> Option<&CodexRuntime> {
        self.runtime.as_ref()
    }

    pub(crate) fn stage_mcp(
        &mut self,
        authorizer: &McpAuthorizer,
        session_id: &str,
        runtime_epoch: u64,
        token: &str,
        role: &AgentMcpRole,
    ) {
        self.provisional.take();
        authorizer.register_provisional(
            session_id.to_owned(),
            runtime_epoch,
            role.clone(),
            token.to_owned(),
        );
        self.provisional = Some(ProvisionalMcpAdmission {
            authorizer: authorizer.clone(),
            session_id: session_id.to_owned(),
            runtime_epoch,
            token: token.to_owned(),
        });
    }

    pub(crate) fn prepare(
        &mut self,
        request: ProviderRuntimePreparation<'_>,
    ) -> Result<(), ProviderRuntimePreparationError> {
        use ProviderRuntimePreparationError::{AccountUnavailable, EndpointBindingFailed, Runtime};
        if let Some(account) = request.account {
            account.prepare().map_err(|_| AccountUnavailable)?;
        }
        let resume = matches!(request.mode, ProviderRuntimeMode::Resume);
        let codex_supported = request.agent_id == "codex"
            && request
                .transport
                .is_some_and(|transport| transport.daemon_owned_bridge_supported("codex"));
        if let Some((token, role)) = request.mcp {
            self.stage_mcp(
                request.authorizer,
                request.session_id,
                request.runtime_epoch,
                token,
                role,
            );
        }
        if request.agent_id != "codex" {
            return Ok(());
        }
        if !codex_supported {
            return if resume {
                self.revoke_provisional();
                Err(Runtime(AgentResumePreparationError::ProviderRejected))
            } else {
                Ok(())
            };
        }
        let transport = request.transport.expect("supported bridge transport");
        let signals = request.signals.take().ok_or_else(|| {
            if resume {
                self.revoke_provisional();
            }
            Runtime(AgentResumePreparationError::ProviderRejected)
        })?;
        let runtime = start_codex_runtime(
            request.session_id,
            request.runtime_epoch,
            request.cwd,
            request.managed_worktree,
            request.account,
            &transport.provider_process_directory,
            request
                .mcp
                .map(|(token, role)| termloop_invocation::AgentMcpLaunch {
                    endpoint: &transport.mcp_endpoint,
                    token,
                    claude_config_path: &transport.claude_mcp_config_path,
                    profile: role.invocation_profile(),
                }),
            request
                .launch
                .as_ref()
                .and_then(|launch| launch.codex_app_server_developer_instructions()),
            signals,
        )
        .map_err(|error| {
            // An optional bridge failure may still launch a direct TUI. Keep
            // its transport admission until that launch commits or is dropped.
            if resume {
                self.revoke_provisional();
            }
            Runtime(error)
        })?;
        self.runtime = Some(runtime);
        if let Some(history) = request.history
            && let Err(error) = self
                .runtime
                .as_ref()
                .expect("prepared runtime")
                .warm_thread_history(history)
        {
            let reason = match error {
                termloop_agents::CodexThreadHistoryProbeError::Damaged => {
                    AgentResumePreparationError::ProviderHistoryDamaged
                }
                termloop_agents::CodexThreadHistoryProbeError::Unavailable => {
                    AgentResumePreparationError::ProviderRejected
                }
            };
            return Err(Runtime(if self.abort().is_ok() {
                reason
            } else {
                AgentResumePreparationError::RuntimeOwnershipUncertain
            }));
        }
        if let Some(launch) = request.launch {
            launch
                .bind_codex_app_server_endpoint(
                    self.runtime.as_ref().expect("prepared runtime").endpoint(),
                )
                .map_err(|_| EndpointBindingFailed)?;
        }
        Ok(())
    }

    /// Core has already committed and promoted this exact credential. Dropping
    /// the provisional guard preserves promoted entries and newer credentials.
    pub(crate) fn take_committed(&mut self) -> Option<CodexRuntime> {
        self.provisional.take();
        self.runtime.take()
    }

    pub(crate) fn revoke_provisional(&mut self) {
        self.provisional.take();
    }

    pub(crate) fn abort(&mut self) -> Result<(), AgentResumeReapError> {
        self.revoke_provisional();
        self.runtime
            .take()
            .map(CodexRuntime::reap)
            .transpose()
            .map(|_| ())
    }
}

impl Drop for PreparedProviderRuntime {
    fn drop(&mut self) {
        let _ = self.abort();
    }
}

pub struct CodexRuntime {
    process: termloop_platform::ManagedProcess,
    bridge: termloop_agents::CodexAppServerBridge,
    upstream_endpoint: String,
}

impl CodexRuntime {
    pub(crate) fn endpoint(&self) -> &str {
        self.bridge.endpoint()
    }

    pub(crate) fn warm_thread_history(
        &self,
        native_thread_id: &str,
    ) -> Result<(), termloop_agents::CodexThreadHistoryProbeError> {
        termloop_agents::probe_codex_thread_history(&self.upstream_endpoint, native_thread_id)
    }

    pub(crate) fn inspect_thread_history(
        &self,
        native_thread_id: &str,
    ) -> Result<
        termloop_agents::CodexThreadHistoryInspection,
        termloop_agents::CodexThreadHistoryProbeError,
    > {
        termloop_agents::inspect_codex_thread_history(&self.upstream_endpoint, native_thread_id)
    }

    pub fn reap(self) -> Result<(), AgentResumeReapError> {
        let Self {
            mut process,
            bridge,
            upstream_endpoint: _,
        } = self;
        let bridge_reaped = bridge.shutdown().is_ok();
        let process_reaped = process.terminate().is_ok();
        if bridge_reaped && process_reaped {
            Ok(())
        } else {
            Err(AgentResumeReapError)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn start_codex_runtime(
    session_id: &str,
    runtime_epoch: u64,
    cwd: &str,
    managed_worktree: bool,
    account: Option<&termloop_agents::AgentAccountContext>,
    provider_process_directory: &Path,
    mcp: Option<termloop_invocation::AgentMcpLaunch<'_>>,
    developer_instructions: Option<&str>,
    signals: Sender<crate::AgentRuntimeSignal>,
) -> Result<CodexRuntime, crate::AgentResumePreparationError> {
    let port = termloop_platform::reserve_loopback_port()
        .map_err(|_| crate::AgentResumePreparationError::ProviderRejected)?;
    let upstream_endpoint = format!("ws://127.0.0.1:{port}");
    let launch = if managed_worktree {
        termloop_invocation::codex_app_server_for_managed_worktree(
            &upstream_endpoint,
            cwd,
            session_id,
            mcp,
            developer_instructions,
            account,
        )
    } else {
        termloop_invocation::codex_app_server(
            &upstream_endpoint,
            cwd,
            session_id,
            mcp,
            developer_instructions,
            account,
        )
    }
    .map_err(|_| crate::AgentResumePreparationError::ProviderRejected)?;
    let mut process = termloop_platform::spawn_tracked_managed_process_with_environment(
        launch.program(),
        launch.args(),
        Path::new(cwd),
        provider_process_directory,
        session_id,
        launch.environment(),
    )
    .map_err(|error| match error {
        termloop_platform::PlatformError::ProcessOwnershipUncertain => {
            crate::AgentResumePreparationError::RuntimeOwnershipUncertain
        }
        termloop_platform::PlatformError::Io(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            crate::AgentResumePreparationError::RuntimeConflict
        }
        _ => crate::AgentResumePreparationError::ProviderRejected,
    })?;
    let bridge = match termloop_agents::CodexAppServerBridge::start(
        upstream_endpoint.clone(),
        session_id.to_owned(),
        runtime_epoch,
        signals,
    ) {
        Ok(bridge) => bridge,
        Err(_) if process.terminate().is_err() => {
            return Err(crate::AgentResumePreparationError::RuntimeOwnershipUncertain);
        }
        Err(_) => return Err(crate::AgentResumePreparationError::ProviderRejected),
    };
    Ok(CodexRuntime {
        process,
        bridge,
        upstream_endpoint,
    })
}
