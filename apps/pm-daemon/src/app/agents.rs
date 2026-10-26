//! PM agent sessions: launch in a PTY, the per-agent MCP bearer that binds
//! tool calls to the session's project and mode, stop, and exit handling.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use termloop_pm::agent::{
    AssistantTask, PmAgentMode, PmAgentProfile, PmLaunchRequest, PmToolContext, SkillRunContext,
    claude_mcp_config, pm_launch_plan,
};
use termloop_pm::{DeliveryCheck, DeliveryCheckOutcome, PmSettings};
use termloop_pm_contract::pm::EventName;

use crate::app::AppState;
use crate::app::control::constant_time_equal;
use crate::app::control::errors::ControlError;
use crate::app::control::errors::{constraint, internal, not_found};

const AGENT_FILES_DIRECTORY: &str = "agents";
const WORKSPACES_DIRECTORY: &str = "workspaces";
/// Exited sessions kept per project for `pm_agent_list`.
const EXITED_SESSIONS_KEPT: usize = 16;
/// A skill run is unattended and calls only its approved PM tools; any
/// other tool would wait for a person, so nothing else is pre-approved.
const SKILL_RUN_PERMISSION: &str = "default";
/// How long a description update keeps running after its draft, so its
/// closing reply reaches the terminal.
const STOP_AFTER_DRAFT: Duration = Duration::from_secs(20);

#[derive(Clone)]
pub(crate) struct AgentRecord {
    pub(crate) session_id: String,
    pub(crate) project_id: String,
    pub(crate) mode: PmAgentMode,
    pub(crate) provider: String,
    pub(crate) focus_ticket_id: Option<String>,
    pub(crate) check_id: Option<String>,
    /// The skill run a skill-run agent works for.
    pub(crate) skill: Option<SkillRunContext>,
    /// A description update: its work ends with the draft it proposes.
    ends_with_draft: bool,
    pub(crate) started_at_epoch_ms: u64,
    pub(crate) exited_at_epoch_ms: Option<u64>,
    /// The bearer the agent's MCP client sends; never logged or returned.
    mcp_token: String,
    mcp_config: Option<PathBuf>,
}

impl AgentRecord {
    pub(crate) fn new(
        session_id: String,
        project_id: String,
        mode: PmAgentMode,
        provider: String,
        focus_ticket_id: Option<String>,
        check_id: Option<String>,
        mcp_token: String,
    ) -> Self {
        Self {
            session_id,
            project_id,
            mode,
            provider,
            focus_ticket_id,
            check_id,
            skill: None,
            ends_with_draft: false,
            started_at_epoch_ms: termloop_platform::current_epoch_ms(),
            exited_at_epoch_ms: None,
            mcp_token,
            mcp_config: None,
        }
    }

    fn running(&self) -> bool {
        self.exited_at_epoch_ms.is_none()
    }

    pub(crate) fn value(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "projectId": self.project_id,
            "mode": self.mode.as_str(),
            "provider": self.provider,
            "focusTicketId": self.focus_ticket_id,
            "checkId": self.check_id,
            "skillId": self.skill.as_ref().and_then(|run| run.skill.as_ref()).map(|(id, _)| id),
            "state": if self.running() { "running" } else { "exited" },
            "startedAtEpochMs": self.started_at_epoch_ms,
            "exitedAtEpochMs": self.exited_at_epoch_ms,
        })
    }
}

/// Every PM agent session of this daemon run.
#[derive(Clone, Default)]
pub(crate) struct AgentRegistry {
    sessions: Arc<StdMutex<HashMap<String, AgentRecord>>>,
}

impl AgentRegistry {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, AgentRecord>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn insert(&self, record: AgentRecord) {
        self.lock().insert(record.session_id.clone(), record);
    }

    fn remove(&self, session_id: &str) -> Option<AgentRecord> {
        self.lock().remove(session_id)
    }

    /// The running agent session of a check, when it has one.
    pub(crate) fn check_session(&self, check_id: &str) -> Option<String> {
        self.lock()
            .values()
            .find(|record| record.running() && record.check_id.as_deref() == Some(check_id))
            .map(|record| record.session_id.clone())
    }

    /// The tool context of the running agent holding this MCP bearer, with
    /// its check. The context comes only from the launch, never from a
    /// tool's arguments.
    pub(crate) fn tool_context(&self, bearer: &str) -> Option<(PmToolContext, Option<String>)> {
        self.lock()
            .values()
            .find(|record| {
                record.running()
                    && constant_time_equal(record.mcp_token.as_bytes(), bearer.as_bytes())
            })
            .map(|record| {
                let context = PmToolContext {
                    project_id: record.project_id.clone(),
                    mode: record.mode,
                    ticket_id: record.focus_ticket_id.clone(),
                    skill: record.skill.clone(),
                };
                (context, record.check_id.clone())
            })
    }

    /// The running description update holding this MCP bearer.
    fn draft_session(&self, bearer: &str) -> Option<String> {
        self.lock()
            .values()
            .find(|record| {
                record.running()
                    && record.ends_with_draft
                    && constant_time_equal(record.mcp_token.as_bytes(), bearer.as_bytes())
            })
            .map(|record| record.session_id.clone())
    }

    /// The running agent session of a skill run, when it has one.
    pub(crate) fn skill_run_session(&self, run_id: &str) -> Option<String> {
        self.lock()
            .values()
            .find(|record| {
                record.running()
                    && record
                        .skill
                        .as_ref()
                        .is_some_and(|run| run.run_id == run_id)
            })
            .map(|record| record.session_id.clone())
    }

    /// A project's sessions, newest first.
    pub(crate) fn project_sessions(&self, project_id: &str) -> Vec<Value> {
        let sessions = self.lock();
        let mut records: Vec<&AgentRecord> = sessions
            .values()
            .filter(|record| record.project_id == project_id)
            .collect();
        records.sort_by(|a, b| {
            b.started_at_epoch_ms
                .cmp(&a.started_at_epoch_ms)
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        records.into_iter().map(AgentRecord::value).collect()
    }

    pub(crate) fn running_session(&self, session_id: &str) -> Option<AgentRecord> {
        self.lock()
            .get(session_id)
            .filter(|record| record.running())
            .cloned()
    }

    /// Marks a session exited and drops the project's oldest exited
    /// sessions beyond the bound.
    fn mark_exited(&self, session_id: &str) -> Option<AgentRecord> {
        let mut sessions = self.lock();
        let record = sessions
            .get_mut(session_id)
            .filter(|record| record.running())?;
        record.exited_at_epoch_ms = Some(termloop_platform::current_epoch_ms());
        let exited = record.clone();
        let mut old: Vec<(u64, String)> = sessions
            .values()
            .filter(|record| record.project_id == exited.project_id && !record.running())
            .map(|record| {
                (
                    record.exited_at_epoch_ms.unwrap_or(0),
                    record.session_id.clone(),
                )
            })
            .collect();
        old.sort();
        let excess = old.len().saturating_sub(EXITED_SESSIONS_KEPT);
        for (_, id) in old.into_iter().take(excess) {
            sessions.remove(&id);
        }
        Some(exited)
    }

    fn config_files(&self) -> Vec<PathBuf> {
        self.lock()
            .values()
            .filter_map(|record| record.mcp_config.clone())
            .collect()
    }
}

/// Launches the PM agent for a project in a PTY and returns its session.
pub(crate) fn launch(
    state: &AppState,
    project_id: &str,
    mode: PmAgentMode,
    focus_ticket_id: Option<&str>,
    check_id: Option<&str>,
) -> Result<AgentRecord, ControlError> {
    let profile = {
        let store = state.store.lock();
        store.project(project_id)?.ok_or_else(not_found)?;
        PmAgentProfile::build(&store, project_id, mode, focus_ticket_id)?
    };
    launch_profile(state, project_id, &profile, focus_ticket_id, check_id, None)
}

/// Launches the project's assistant for a task; `UpdateDescription` needs
/// the ticket in focus.
pub(crate) fn launch_assistant(
    state: &AppState,
    project_id: &str,
    focus_ticket_id: Option<&str>,
    task: AssistantTask,
) -> Result<AgentRecord, ControlError> {
    let profile = {
        let store = state.store.lock();
        store.project(project_id)?.ok_or_else(not_found)?;
        PmAgentProfile::build_for(
            &store,
            project_id,
            PmAgentMode::Assistant,
            focus_ticket_id,
            task,
        )?
    };
    launch_profile_with(
        state,
        project_id,
        &profile,
        focus_ticket_id,
        None,
        None,
        task == AssistantTask::UpdateDescription,
    )
}

/// Stops a description update once the draft it proposed has landed; the
/// draft waits on the ticket, so the session has nothing left to do.
pub(crate) fn stop_after_draft(state: &AppState, bearer: &str) {
    let Some(session) = state.agents.draft_session(bearer) else {
        return;
    };
    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(STOP_AFTER_DRAFT).await;
        let _ = stop(&state, &session);
    });
}

/// The model a delivery check launches with. One the provider does not
/// offer (the `haiku` default under Codex) falls back to the agent model.
fn check_model(settings: &PmSettings) -> &str {
    let offered = termloop_agents::agent_descriptor(&settings.agent_provider)
        .is_some_and(|descriptor| descriptor.models.contains(&settings.check_model.as_str()));
    if offered {
        &settings.check_model
    } else {
        &settings.agent_model
    }
}

/// Launches an agent with a built profile; a skill-run agent is bound to
/// its run and the tools that run may call.
pub(crate) fn launch_profile(
    state: &AppState,
    project_id: &str,
    profile: &PmAgentProfile,
    focus_ticket_id: Option<&str>,
    check_id: Option<&str>,
    skill: Option<SkillRunContext>,
) -> Result<AgentRecord, ControlError> {
    launch_profile_with(
        state,
        project_id,
        profile,
        focus_ticket_id,
        check_id,
        skill,
        false,
    )
}

fn launch_profile_with(
    state: &AppState,
    project_id: &str,
    profile: &PmAgentProfile,
    focus_ticket_id: Option<&str>,
    check_id: Option<&str>,
    skill: Option<SkillRunContext>,
    ends_with_draft: bool,
) -> Result<AgentRecord, ControlError> {
    let mode = profile.mode;
    let (settings, folder) = {
        let store = state.store.lock();
        let project = store.project(project_id)?.ok_or_else(not_found)?;
        (store.settings()?, project.folder)
    };
    let permission = match mode {
        PmAgentMode::Assistant | PmAgentMode::SkillCreator => {
            settings.assistant_permission.as_str()
        }
        PmAgentMode::DeliveryCheck => settings.check_permission.as_str(),
        PmAgentMode::SkillRun => SKILL_RUN_PERMISSION,
    };
    // A project's own folder is its team's code: agents read it, never edit it.
    let read_only_workspace = folder.is_some();
    let cwd = match folder {
        Some(folder) => PathBuf::from(folder),
        None => {
            let workspace = state
                .daemon_directory
                .join(WORKSPACES_DIRECTORY)
                .join(project_id);
            std::fs::create_dir_all(&workspace).map_err(|_| internal())?;
            workspace
        }
    };
    let cwd = cwd.to_str().ok_or_else(internal)?.to_owned();
    let session_id = termloop_platform::generate_uuid_v4();
    let mcp_token = termloop_platform::generate_capability_token();
    let files = state.daemon_directory.join(AGENT_FILES_DIRECTORY);
    termloop_platform::ensure_private_directory(&files).map_err(|_| internal())?;
    let config_path = files.join(format!("{session_id}-mcp.json"));
    let config = claude_mcp_config(&state.mcp_endpoint).map_err(|_| internal())?;
    termloop_platform::write_private_file(&config_path, config.as_bytes())
        .map_err(|_| internal())?;
    let config_text = config_path.to_str().ok_or_else(internal)?;
    let mut request = PmLaunchRequest::new(
        &settings.agent_provider,
        &cwd,
        profile,
        &state.mcp_endpoint,
        &mcp_token,
        config_text,
    );
    request.model = match mode {
        PmAgentMode::DeliveryCheck => check_model(&settings),
        _ => &settings.agent_model,
    };
    request.permission = permission;
    request.read_only_workspace = read_only_workspace;
    let plan = pm_launch_plan(request).map_err(|error| {
        tracing::warn!(%error, "the PM agent launch could not be resolved");
        let _ = termloop_platform::remove_file_if_present(&config_path);
        constraint("the agent is unavailable")
    })?;
    let mut record = AgentRecord::new(
        session_id.clone(),
        project_id.to_owned(),
        mode,
        settings.agent_provider.clone(),
        focus_ticket_id.map(str::to_owned),
        check_id.map(str::to_owned),
        mcp_token,
    );
    record.mcp_config = Some(config_path.clone());
    record.skill = skill;
    record.ends_with_draft = ends_with_draft;
    // Registered before the spawn, so the agent's first MCP call is known.
    state.agents.insert(record.clone());
    if let Err(error) = termloop_agent_runtime::spawn_agent_terminal(
        &state.terminal,
        &session_id,
        state.runtime_epoch,
        &cwd,
        &plan.payload,
    ) {
        tracing::warn!(%error, "the PM agent did not start");
        state.agents.remove(&session_id);
        let _ = termloop_platform::remove_file_if_present(&config_path);
        return Err(constraint("the agent is unavailable"));
    }
    state.publish(
        EventName::PmAgentChanged,
        json!({ "projectId": project_id, "sessionId": session_id }),
    );
    Ok(record)
}

/// Launches the delivery-check agent of a started check; returns its
/// session id.
pub(crate) fn launch_check(
    state: &AppState,
    check: &DeliveryCheck,
) -> Result<String, ControlError> {
    launch(
        state,
        &check.project_id,
        PmAgentMode::DeliveryCheck,
        Some(&check.ticket_id),
        Some(&check.id),
    )
    .map(|record| record.session_id)
}

/// Stops a running agent; its exit is handled when the PTY is reaped.
pub(crate) fn stop(state: &AppState, session_id: &str) -> Result<bool, ControlError> {
    if state.agents.running_session(session_id).is_none() {
        return Ok(false);
    }
    state.terminal.terminate(session_id).map_err(|error| {
        tracing::warn!(%error, "failed to stop a PM agent");
        internal()
    })?;
    Ok(true)
}

/// Closes an exited agent's session. A delivery check or skill run that
/// ends without its report is recorded as failed.
pub(crate) fn on_agent_exit(state: &AppState, session_id: &str) {
    let Some(record) = state.agents.mark_exited(session_id) else {
        return;
    };
    if let Some(path) = &record.mcp_config {
        let _ = termloop_platform::remove_file_if_present(path);
    }
    if let Some(check_id) = &record.check_id {
        let finished = state
            .store
            .lock()
            .finish_check(check_id, DeliveryCheckOutcome::Failed);
        // A check the agent reported is already closed; nothing to record.
        if let Ok(check) = finished {
            publish_check(state, &check);
        }
    }
    if let Some(run) = &record.skill {
        super::skills::on_run_exit(state, &record.project_id, &run.run_id);
    }
    state.publish(
        EventName::PmAgentChanged,
        json!({ "projectId": record.project_id, "sessionId": record.session_id }),
    );
}

pub(crate) fn publish_check(state: &AppState, check: &DeliveryCheck) {
    state.publish(
        EventName::PmCheckChanged,
        json!({
            "projectId": check.project_id,
            "ticketId": check.ticket_id,
            "checkId": check.id,
        }),
    );
    state.board_changed(&check.project_id);
}

/// Removes the MCP config files of this run's agents at shutdown.
pub(crate) fn remove_agent_files(state: &AppState) {
    for path in state.agents.config_files() {
        let _ = termloop_platform::remove_file_if_present(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(session_id: &str, token: &str, ends_with_draft: bool) -> AgentRecord {
        let mut record = AgentRecord::new(
            session_id.to_owned(),
            "p1".to_owned(),
            PmAgentMode::Assistant,
            "claude".to_owned(),
            Some("t1".to_owned()),
            None,
            token.to_owned(),
        );
        record.ends_with_draft = ends_with_draft;
        record
    }

    #[test]
    fn only_a_running_description_update_ends_with_its_draft() {
        let agents = AgentRegistry::default();
        agents.insert(record("brief", "token-brief", false));
        agents.insert(record("update", "token-update", true));
        assert_eq!(agents.draft_session("token-brief"), None);
        assert_eq!(
            agents.draft_session("token-update").as_deref(),
            Some("update")
        );
        agents.mark_exited("update");
        assert_eq!(agents.draft_session("token-update"), None);
    }
}
