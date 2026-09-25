use crate::{PreparationError, ReapError};
use std::path::Path;
use std::sync::mpsc::Sender;

pub struct CodexRuntime {
    process: termloop_platform::ManagedProcess,
    bridge: termloop_agents::CodexAppServerBridge,
    upstream_endpoint: String,
    resume_permissions: Option<termloop_agents::CodexResumeLease>,
}

impl CodexRuntime {
    pub fn endpoint(&self) -> &str {
        self.bridge.endpoint()
    }

    pub fn prepare_resume_permissions(
        &mut self,
        launch: &termloop_launch::LaunchPayload,
    ) -> Result<(), PreparationError> {
        if let Some(request) = launch.codex_resume_permissions() {
            self.resume_permissions = Some(
                termloop_agents::prepare_codex_resume_permissions(&self.upstream_endpoint, request)
                    .map_err(|_| PreparationError::ProviderRejected)?,
            );
        }
        Ok(())
    }

    pub fn warm_thread_history(
        &self,
        native_thread_id: &str,
    ) -> Result<(), termloop_agents::CodexThreadHistoryProbeError> {
        termloop_agents::probe_codex_thread_history(&self.upstream_endpoint, native_thread_id)
    }

    pub fn inspect_thread_history(
        &self,
        native_thread_id: &str,
    ) -> Result<
        termloop_agents::CodexThreadHistoryInspection,
        termloop_agents::CodexThreadHistoryProbeError,
    > {
        termloop_agents::inspect_codex_thread_history(&self.upstream_endpoint, native_thread_id)
    }

    pub fn reap(self) -> Result<(), ReapError> {
        let Self {
            mut process,
            bridge,
            upstream_endpoint: _,
            resume_permissions,
        } = self;
        drop(resume_permissions);
        let bridge_reaped = bridge.shutdown().is_ok();
        let process_reaped = process.terminate().is_ok();
        if bridge_reaped && process_reaped {
            Ok(())
        } else {
            Err(ReapError)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn start_codex_runtime(
    session_id: &str,
    runtime_epoch: u64,
    cwd: &str,
    managed_worktree: bool,
    account: Option<&termloop_agents::AgentAccountContext>,
    provider_process_directory: &Path,
    mcp: Option<termloop_launch::McpConnection<'_>>,
    developer_instructions: Option<&str>,
    signals: Sender<termloop_agents::AgentRuntimeSignal>,
) -> Result<CodexRuntime, PreparationError> {
    start_codex_runtime_with_executable_directory(
        session_id,
        runtime_epoch,
        cwd,
        managed_worktree,
        account,
        provider_process_directory,
        mcp,
        developer_instructions,
        signals,
        None,
        &termloop_launch::CodexRuntimePolicy::default(),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn start_codex_runtime_with_executable_directory(
    session_id: &str,
    runtime_epoch: u64,
    cwd: &str,
    managed_worktree: bool,
    account: Option<&termloop_agents::AgentAccountContext>,
    provider_process_directory: &Path,
    mcp: Option<termloop_launch::McpConnection<'_>>,
    developer_instructions: Option<&str>,
    signals: Sender<termloop_agents::AgentRuntimeSignal>,
    executable_directory: Option<&Path>,
    policy: &termloop_launch::CodexRuntimePolicy,
) -> Result<CodexRuntime, PreparationError> {
    let port = termloop_platform::reserve_loopback_port()
        .map_err(|_| PreparationError::ProviderRejected)?;
    let upstream_endpoint = format!("ws://127.0.0.1:{port}");
    let launch = termloop_launch::codex_app_server_with_project_trust(
        &upstream_endpoint,
        cwd,
        session_id,
        mcp,
        developer_instructions,
        account,
        if managed_worktree {
            termloop_launch::CodexProjectTrust::ManagedWorkspace
        } else {
            termloop_launch::CodexProjectTrust::Inherit
        },
        executable_directory,
        policy,
    )
    .map_err(|_| PreparationError::ProviderRejected)?;
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
            PreparationError::RuntimeOwnershipUncertain
        }
        termloop_platform::PlatformError::Io(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            PreparationError::RuntimeConflict
        }
        _ => PreparationError::ProviderRejected,
    })?;
    let bridge = match termloop_agents::CodexAppServerBridge::start(
        upstream_endpoint.clone(),
        session_id.to_owned(),
        runtime_epoch,
        signals,
    ) {
        Ok(bridge) => bridge,
        Err(_) if process.terminate().is_err() => {
            return Err(PreparationError::RuntimeOwnershipUncertain);
        }
        Err(_) => return Err(PreparationError::ProviderRejected),
    };
    Ok(CodexRuntime {
        process,
        bridge,
        upstream_endpoint,
        resume_permissions: None,
    })
}
