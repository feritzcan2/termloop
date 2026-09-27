use crate::CodexPermissionMode;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Private, launch-scoped preparation for the exact provider conversation.
/// No user message or turn is submitted by this request.
#[derive(Clone)]
pub struct CodexResumePermissions {
    native_thread_id: String,
    fork: bool,
    cwd: String,
    permission: CodexPermissionMode,
    model: Option<String>,
    reasoning: Option<String>,
    workspace_network: Option<bool>,
}

impl CodexResumePermissions {
    pub fn new(native_thread_id: &str, cwd: &str, permission: CodexPermissionMode) -> Option<Self> {
        termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Codex,
            native_thread_id.into(),
        )?;
        if cwd.is_empty() || cwd.len() > 32_768 || cwd.contains('\0') {
            return None;
        }
        Some(Self {
            native_thread_id: native_thread_id.into(),
            fork: false,
            cwd: cwd.into(),
            permission,
            model: None,
            reasoning: None,
            workspace_network: None,
        })
    }

    /// Apply explicit launch selections before the remote TUI attaches.
    /// Defaults preserve the provider's saved conversation settings.
    pub fn with_configuration(mut self, model: &str, reasoning: &str) -> Self {
        self.model = (model != "default").then(|| model.to_owned());
        self.reasoning = (reasoning != "default").then(|| reasoning.to_owned());
        self
    }

    pub fn with_workspace_network(mut self, enabled: Option<bool>) -> Self {
        self.workspace_network = enabled;
        self
    }

    pub fn native_thread_id(&self) -> &str {
        &self.native_thread_id
    }

    pub fn for_fork(mut self) -> Self {
        self.fork = true;
        self
    }

    pub fn is_fork(&self) -> bool {
        self.fork
    }

    pub fn permission(&self) -> CodexPermissionMode {
        self.permission
    }

    fn settings(&self) -> (&'static str, &'static str, &'static str, &'static str) {
        match self.permission {
            CodexPermissionMode::Default => {
                ("on-request", "user", "workspace-write", "workspaceWrite")
            }
            CodexPermissionMode::AcceptEdits => (
                "on-request",
                "auto_review",
                "workspace-write",
                "workspaceWrite",
            ),
            CodexPermissionMode::Plan => ("on-request", "user", "read-only", "readOnly"),
            CodexPermissionMode::BypassPermissions => {
                ("never", "user", "danger-full-access", "dangerFullAccess")
            }
        }
    }

    fn params(&self) -> Value {
        let (approval, reviewer, sandbox, _) = self.settings();
        let mut params = json!({
            "threadId": self.native_thread_id,
            "cwd": self.cwd,
            "approvalPolicy": approval,
            "approvalsReviewer": reviewer,
            "sandbox": sandbox,
            "excludeTurns": true,
        });
        if let Some(model) = &self.model {
            params["model"] = json!(model);
        }
        if let Some(reasoning) = &self.reasoning {
            params["config"] = json!({ "model_reasoning_effort": reasoning });
        }
        if let Some(enabled) = self.workspace_network {
            if params.get("config").is_none() {
                params["config"] = json!({});
            }
            params["config"]["sandbox_workspace_write.network_access"] = json!(enabled);
        }
        params
    }

    fn matches(&self, result: &Value) -> bool {
        let (approval, reviewer, _, sandbox) = self.settings();
        let identity_matches = if self.fork {
            result
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .is_some_and(|id| {
                    id != self.native_thread_id
                        && termloop_domain::ResumeRef::for_provider(
                            termloop_domain::ResumeProvider::Codex,
                            id.into(),
                        )
                        .is_some()
                })
                && result
                    .pointer("/thread/forkedFromId")
                    .and_then(Value::as_str)
                    == Some(self.native_thread_id.as_str())
        } else {
            result.pointer("/thread/id").and_then(Value::as_str)
                == Some(self.native_thread_id.as_str())
        };
        identity_matches
            && result.get("approvalPolicy").and_then(Value::as_str) == Some(approval)
            && result.get("approvalsReviewer").and_then(Value::as_str) == Some(reviewer)
            && result.pointer("/sandbox/type").and_then(Value::as_str) == Some(sandbox)
            && self.workspace_network.is_none_or(|enabled| {
                sandbox != "workspaceWrite"
                    || result
                        .pointer("/sandbox/networkAccess")
                        .and_then(Value::as_bool)
                        == Some(enabled)
            })
            && self.model.as_ref().is_none_or(|model| {
                result.get("model").and_then(Value::as_str) == Some(model.as_str())
            })
            && self.reasoning.as_ref().is_none_or(|reasoning| {
                result.get("reasoningEffort").and_then(Value::as_str) == Some(reasoning.as_str())
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexResumePermissionsError;

/// Keeps the prepared thread loaded until its owning runtime is reaped.
/// Codex unloads a thread when its last client disconnects; dropping this
/// connection before the TUI attaches would lose the verified permissions.
pub struct CodexResumeLease {
    native_thread_id: String,
    fork_source: Option<String>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl CodexResumeLease {
    pub fn native_thread_id(&self) -> &str {
        &self.native_thread_id
    }

    pub fn fork_source(&self) -> Option<&str> {
        self.fork_source.as_deref()
    }
}

impl Drop for CodexResumeLease {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Configure the provider before its TUI attaches. Unlike CLI flags, the
/// App Server accepts permission overrides on thread/resume and thread/fork. A mismatched or
/// rejected response must prevent the caller from launching that TUI.
pub fn prepare_codex_resume_permissions(
    endpoint: &str,
    request: &CodexResumePermissions,
) -> Result<CodexResumeLease, CodexResumePermissionsError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| CodexResumePermissionsError)?;
    let endpoint = endpoint.to_owned();
    let request = request.clone();
    let fork_source = request.fork.then(|| request.native_thread_id.clone());
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel();
    let worker = std::thread::Builder::new()
        .name("codex-resume-permissions".into())
        .spawn(move || {
            runtime.block_on(async {
                let prepared =
                    tokio::time::timeout(Duration::from_secs(20), prepare(&endpoint, &request))
                        .await;
                let (mut socket, native_thread_id) = match prepared {
                    Ok(Ok(prepared)) => prepared,
                    _ => {
                        let _ = ready_tx.send(Err(CodexResumePermissionsError));
                        return;
                    }
                };
                if ready_tx.send(Ok(native_thread_id)).is_err() {
                    return;
                }
                loop {
                    tokio::select! {
                        _ = &mut stop_rx => break,
                        frame = socket.next() => match frame {
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                            Some(Ok(_)) => {},
                        },
                    }
                }
            });
        })
        .map_err(|_| CodexResumePermissionsError)?;
    let mut lease = CodexResumeLease {
        native_thread_id: String::new(),
        fork_source,
        stop: Some(stop_tx),
        worker: Some(worker),
    };
    lease.native_thread_id = ready_rx.recv().map_err(|_| CodexResumePermissionsError)??;
    Ok(lease)
}

async fn prepare(
    endpoint: &str,
    request: &CodexResumePermissions,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        String,
    ),
    CodexResumePermissionsError,
> {
    let (mut socket, _) = connect_async(endpoint)
        .await
        .map_err(|_| CodexResumePermissionsError)?;
    let mut native_thread_id = String::new();
    for (id, method, params) in [
        (
            "termloop-resume-initialize",
            "initialize",
            json!({
                "clientInfo": { "name": "termloop", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true },
            }),
        ),
        (
            "termloop-resume-permissions",
            if request.fork {
                "thread/fork"
            } else {
                "thread/resume"
            },
            request.params(),
        ),
    ] {
        socket
            .send(Message::Text(
                json!({ "id": id, "method": method, "params": params })
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|_| CodexResumePermissionsError)?;
        let response = loop {
            let frame = socket
                .next()
                .await
                .ok_or(CodexResumePermissionsError)?
                .map_err(|_| CodexResumePermissionsError)?;
            let Message::Text(text) = frame else { continue };
            if text.len() > 1024 * 1024 {
                return Err(CodexResumePermissionsError);
            }
            let value: Value =
                serde_json::from_str(&text).map_err(|_| CodexResumePermissionsError)?;
            if value.get("id").and_then(Value::as_str) == Some(id) {
                if value.get("error").is_some() {
                    return Err(CodexResumePermissionsError);
                }
                break value
                    .get("result")
                    .cloned()
                    .ok_or(CodexResumePermissionsError)?;
            }
        };
        if method == "initialize" {
            socket
                .send(Message::Text(
                    json!({ "method": "initialized" }).to_string().into(),
                ))
                .await
                .map_err(|_| CodexResumePermissionsError)?;
        } else if !request.matches(&response) {
            return Err(CodexResumePermissionsError);
        } else {
            native_thread_id = response
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or(CodexResumePermissionsError)?
                .to_owned();
        }
    }
    Ok((socket, native_thread_id))
}

#[cfg(test)]
mod tests;
