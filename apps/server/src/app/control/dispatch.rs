use std::sync::{Arc, atomic::Ordering};

use serde_json::{Value, json};
use termloop_contract::current as protocol;
use termloop_contract::current::{
    AgentObserveParams, CONTRACT_IDENTITY, ControlRequest, ControlResponse, ControlSubscribeParams,
    ControlSubscribeResult, ErrorCode, ProjectDeleteBlocker, ProjectionInvalidatedPayload,
    ProjectionTopic, ProtocolErrorDetails,
};
use termloop_core::companion_integrations::assistant_session::StewardWakeAdmission;
use tokio::time::{Duration, Instant};

use super::super::core_lock::{in_operation, record_operation_duration};
use super::super::health::refresh_all_health_demands;
use super::super::invalidation::{
    InvalidationRequest, invalidate_automatic_git_host_task, mutation_topics,
    refresh_task_presence_for_cwd,
};
use super::super::{AppState, current_epoch_ms};
use super::errors::{git_observation_error_response, response_conflict, response_error};
use super::handlers::{
    bind_task_branch, cleanup_task_worktree, close_session, create_worker_configuration,
    delete_project, delete_steward_configuration, delete_worker_configuration,
    dismiss_task_worktree_provisioning, dismiss_task_worktree_repair, fork_agent_session,
    get_context_bank_catalog, get_context_bank_file, get_skill_catalog, get_skill_definition,
    git_host_pull_request_change_list, git_host_pull_request_diff, git_host_pull_request_list,
    inspect_task_worktree_cleanup, inspect_task_worktree_repair, launch_agent_session,
    launch_assistant_prompt_improver, launch_current_worker, launch_project_run,
    launch_quick_action, launch_run_configuration_improver, launch_settings_improver,
    launch_task_run, launch_task_session, list_deleted_sessions, list_session_history,
    paste_agent_image, preview_agent_session, preview_assistant_prompt_improver,
    preview_quick_action, preview_relocate_agent_session, preview_relocate_agent_to_project,
    preview_resume_agent_session, preview_run_configuration_improver,
    preview_session_history_resume, preview_settings_improver, preview_task_agent_session,
    project_list_local_branches, project_worktree_change_list, project_worktree_diff,
    project_worktree_pre_image, project_worktree_summary, provision_task_worktree,
    relocate_agent_session, repair_provider_history, repair_task_worktree,
    resolve_context_bank_sibling_conflict, resolve_stale_task_worktree, restart_agent_session,
    restart_agents_for_client_launch, restore_deleted_session, resume_agent_session,
    save_context_bank_file, save_skill_definition, session_history_preview, set_skill_deployment,
    set_steward_configuration, task_branch_commit_change_list, task_branch_commit_diff,
    task_branch_commit_list, task_branch_commit_summary_list, task_worktree_change_list,
    task_worktree_diff, task_worktree_pre_image, terminate_session, update_worker_configuration,
};
use super::{
    ClientScope, ConnectionOrigin, constant_time_equal, origin_allows_method, scope_allows_method,
};

pub(super) fn companion_transcript_author(scope: ClientScope) -> &'static str {
    match scope {
        ClientScope::Companion => "steward",
        ClientScope::Full => "user",
        ClientScope::ReadOnly | ClientScope::Hook => "",
    }
}

/// Wire trigger mode to the domain value. A scheduled Routine keeps its own
/// cadence; an on-demand one runs only when a pipeline step asks it to check
/// one Task.
fn routine_trigger_mode(value: protocol::RoutineTriggerMode) -> termloop_core::RoutineTriggerMode {
    match value {
        protocol::RoutineTriggerMode::Schedule => termloop_core::RoutineTriggerMode::Schedule,
        protocol::RoutineTriggerMode::OnDemand => termloop_core::RoutineTriggerMode::OnDemand,
    }
}

fn routine_action_handling(
    value: protocol::RoutineActionHandling,
) -> termloop_core::RoutineActionHandling {
    match value {
        protocol::RoutineActionHandling::Off => termloop_core::RoutineActionHandling::Off,
        protocol::RoutineActionHandling::Ask => termloop_core::RoutineActionHandling::Ask,
        protocol::RoutineActionHandling::Auto => termloop_core::RoutineActionHandling::Auto,
    }
}

fn publish_tracker_mutation(
    result: Result<serde_json::Value, termloop_core::CoreError>,
    state: &AppState,
    core: &termloop_core::CoreRuntime,
) -> Result<serde_json::Value, termloop_core::CoreError> {
    if result.is_ok() {
        state.tracker_runtime_wake.notify_one();
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Routine],
            state_revision: core.state_revision(),
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
    }
    result
}

async fn restore_configuration_version(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let plan = state
        .core
        .lock()
        .await
        .prepare_configuration_version_restore(params)?;
    apply_configuration_plan(plan, state).await
}

pub(in crate::app) async fn apply_configuration_plan(
    plan: termloop_core::ConfigurationApplicationPlan,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let applied_at_epoch_ms = current_epoch_ms();
    let (external, owned) = {
        let mut core = state.core.lock().await;
        if matches!(
            plan.target.target_kind,
            termloop_core::ImproverSessionTargetKind::SettingsSkill
                | termloop_core::ImproverSessionTargetKind::SettingsPrompt
        ) {
            let skill_catalog = (plan.target.target_kind
                == termloop_core::ImproverSessionTargetKind::SettingsSkill)
                .then(|| core.plan_skill_catalog(Some(&plan.project_id)))
                .transpose()?;
            (Some((plan, skill_catalog)), None)
        } else {
            let availability =
                configuration_agent_id(&plan.content)
                    .map(|agent_id| {
                        if state.agent_capabilities.iter().any(|capability| {
                            capability.agent_id == agent_id && capability.available
                        }) {
                            termloop_core::AssistantAvailability::Proven
                        } else {
                            termloop_core::AssistantAvailability::Unavailable
                        }
                    })
                    .unwrap_or(termloop_core::AssistantAvailability::Proven);
            let project_id = plan.project_id.clone();
            let (result, effects) = core.apply_owned_configuration_application(
                plan,
                availability,
                applied_at_epoch_ms,
            )?;
            let state_revision = core.state_revision();
            (None, Some((result, effects, project_id, state_revision)))
        }
    };

    let (result, effects, project_id, state_revision) =
        if let Some((plan, skill_catalog)) = external {
            apply_external_configuration(&plan, skill_catalog, state).await?;
            let project_id = plan.project_id.clone();
            let activated_target = plan.target.clone();
            let activated_content = plan.content.clone();
            let mut core = state.core.lock().await;
            let result = core.finish_configuration_application(
                plan,
                activated_target,
                activated_content,
                applied_at_epoch_ms,
            )?;
            (
                result,
                termloop_core::ConfigurationApplicationEffects::default(),
                project_id,
                core.state_revision(),
            )
        } else {
            owned.expect("owned configuration application result")
        };

    for session_id in effects.retired_session_ids {
        if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
            capabilities.revoke_session(&session_id);
        }
        let _ = terminate_session(json!({ "sessionId": session_id }), state).await;
    }
    if let Some(worker_id) = effects.launch_worker_id {
        launch_current_worker(&worker_id, state).await?;
    }
    if effects.tracker_runtime_changed {
        state.tracker_runtime_wake.notify_one();
    }
    if effects.steward_configuration_changed {
        super::super::companion_supervisor::replace_steward_configuration_wake(state, &project_id)
            .await;
    }
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Steward,
            ProjectionTopic::Worker,
            ProjectionTopic::Routine,
            ProjectionTopic::Playbook,
            ProjectionTopic::Run,
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
        ],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(result)
}

fn configuration_agent_id(content: &str) -> Option<String> {
    let content = content.parse::<Value>().ok()?;
    content
        .get("agentId")
        .or_else(|| content.get("preferredWorkerAgentId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

async fn apply_external_configuration(
    plan: &termloop_core::ConfigurationApplicationPlan,
    skill_catalog: Option<termloop_core::SkillCatalogPlan>,
    state: &AppState,
) -> Result<(), termloop_core::CoreError> {
    let target_id = plan
        .target
        .target_id
        .as_deref()
        .ok_or_else(|| termloop_core::CoreError::InvalidParams("targetId".into()))?;
    let expected_content = plan
        .expected_current_content
        .as_deref()
        .ok_or(termloop_core::CoreError::RevisionConflict)?;
    match plan.target.target_kind {
        termloop_core::ImproverSessionTargetKind::SettingsSkill => {
            let catalog = skill_catalog
                .ok_or_else(|| termloop_core::CoreError::InvalidParams("target".into()))?;
            let manager = state.skill_manager.clone();
            let skill_id = target_id.to_owned();
            let next_content = plan.content.clone();
            let expected_content = expected_content.to_owned();
            tokio::task::spawn_blocking(move || {
                let scope = super::handlers::platform_scope(&catalog);
                let current = manager
                    .read_definition(scope.clone(), &skill_id)
                    .map_err(skill_application_error)?;
                if current.content != expected_content {
                    return Err(termloop_core::CoreError::RevisionConflict);
                }
                manager
                    .write_definition(scope, &skill_id, &current.content_sha256, &next_content)
                    .map_err(skill_application_error)?;
                Ok(())
            })
            .await
            .map_err(|_| {
                termloop_core::CoreError::Terminal(
                    "skill definition worker stopped unexpectedly".into(),
                )
            })?
        }
        termloop_core::ImproverSessionTargetKind::SettingsPrompt => {
            let path = std::path::PathBuf::from(target_id);
            if !path.is_absolute()
                || prompt_identity(expected_content) != prompt_identity(&plan.content)
            {
                return Err(termloop_core::CoreError::InvalidParams("content".into()));
            }
            let expected_content = expected_content.to_owned();
            let next_content = plan.content.clone();
            tokio::task::spawn_blocking(move || {
                let current = termloop_platform::read_bounded_file_if_present(&path, 512 * 1024)
                    .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))?;
                if current
                    .as_deref()
                    .is_some_and(|bytes| bytes != expected_content.as_bytes())
                {
                    return Err(termloop_core::CoreError::RevisionConflict);
                }
                termloop_platform::atomic_replace_private_file(&path, next_content.as_bytes())
                    .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))
            })
            .await
            .map_err(|_| {
                termloop_core::CoreError::Terminal(
                    "prompt override worker stopped unexpectedly".into(),
                )
            })?
        }
        _ => Err(termloop_core::CoreError::InvalidParams("target".into())),
    }
}

fn prompt_identity(content: &str) -> Option<&str> {
    content.lines().find_map(|line| {
        let value = line.trim().strip_prefix("- id: `")?.strip_suffix('`')?;
        (!value.is_empty()).then_some(value)
    })
}

fn skill_application_error(
    error: termloop_platform::SkillManagerError,
) -> termloop_core::CoreError {
    match error {
        termloop_platform::SkillManagerError::SkillNotFound => termloop_core::CoreError::NotFound,
        termloop_platform::SkillManagerError::StaleDefinition => {
            termloop_core::CoreError::RevisionConflict
        }
        other => termloop_core::CoreError::Terminal(other.to_string()),
    }
}

async fn archive_task(params: Value, state: &AppState) -> Result<Value, termloop_core::CoreError> {
    let (plan, runtimes) = {
        let mut core = state.core.lock().await;
        let plan = core.prepare_task_archive(params)?;
        let runtimes = core.detach_task_archive_runtimes(&plan);
        (plan, runtimes)
    };
    let terminal = state.terminal.clone();
    let session_ids = plan.session_ids().to_vec();
    let retirement =
        tokio::task::spawn_blocking(move || -> Result<(), termloop_core::CoreError> {
            drop(runtimes);
            for session_id in session_ids {
                if terminal
                    .contains_session(&session_id)
                    .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))?
                {
                    terminal
                        .terminate(&session_id)
                        .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))?;
                }
            }
            Ok(())
        })
        .await
        .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))?;
    if retirement.is_err() {
        let mut core = state.core.lock().await;
        core.mark_task_archive_recovery_attention(&plan)?;
        return Err(termloop_core::CoreError::ArchiveRecoveryAttention {
            task_id: plan.task_id().to_owned(),
            operation_id: plan.operation_id().to_owned(),
        });
    }
    let mut core = state.core.lock().await;
    let result = core.complete_task_archive(plan)?;
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Task,
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
        ],
        state_revision: core.state_revision(),
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(result)
}

async fn archive_session(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let (plan, runtime) = {
        let mut core = state.core.lock().await;
        let plan = core.prepare_session_archive(params)?;
        let runtime = core.detach_session_archive_runtime(&plan);
        (plan, runtime)
    };
    let terminal = state.terminal.clone();
    let session_id = plan.session_id().to_owned();
    let retirement = tokio::task::spawn_blocking(move || {
        drop(runtime);
        if terminal
            .contains_session(&session_id)
            .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))?
        {
            terminal
                .terminate(&session_id)
                .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))?;
        }
        Ok::<(), termloop_core::CoreError>(())
    })
    .await
    .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))?;
    if retirement.is_err() {
        let mut core = state.core.lock().await;
        core.mark_session_archive_recovery_attention(&plan)?;
        return Err(termloop_core::CoreError::InvalidParams(
            "sessionArchiveRecoveryAttention".into(),
        ));
    }
    let mut core = state.core.lock().await;
    let result = core.complete_session_archive(plan)?;
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Session, ProjectionTopic::AgentStatus],
        state_revision: core.state_revision(),
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(result)
}

async fn restore_task(params: Value, state: &AppState) -> Result<Value, termloop_core::CoreError> {
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.handle("task.restore", params)?;
        (result, core.state_revision())
    };
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Task,
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
        ],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    let session_ids = result
        .get("resume_session_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    resume_task_sessions(session_ids, state).await;
    Ok(result)
}

async fn reopen_task(params: Value, state: &AppState) -> Result<Value, termloop_core::CoreError> {
    let (result, session_ids, state_revision) = {
        let mut core = state.core.lock().await;
        let (result, session_ids) = core.reopen_task_with_resume_plan(params)?;
        (result, session_ids, core.state_revision())
    };
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Task,
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
        ],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    resume_task_sessions(session_ids, state).await;
    Ok(result)
}

async fn resume_task_sessions(session_ids: Vec<String>, state: &AppState) {
    for session_id in session_ids {
        let preview =
            match preview_resume_agent_session(json!({ "sessionId": session_id }), state).await {
                Ok(preview) => preview,
                Err(_) => continue,
            };
        let Some(launch_ticket) = preview
            .get("launch_ticket")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        let _ = resume_agent_session(
            json!({ "sessionId": session_id, "launchTicket": launch_ticket }),
            state,
        )
        .await;
    }
}

async fn restore_archived_session(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| termloop_core::CoreError::InvalidParams("sessionId".into()))?
        .to_owned();
    let restored = {
        let mut core = state.core.lock().await;
        core.handle("session.restoreArchived", params)?
    };
    let preview = preview_resume_agent_session(json!({ "sessionId": session_id }), state).await?;
    let launch_ticket = preview
        .get("launch_ticket")
        .and_then(Value::as_str)
        .ok_or_else(|| termloop_core::CoreError::InvalidParams("launchTicket".into()))?
        .to_owned();
    let _ = resume_agent_session(
        json!({ "sessionId": session_id, "launchTicket": launch_ticket }),
        state,
    )
    .await?;
    Ok(restored)
}

fn agent_plan_step_status(
    status: termloop_contract::current::AgentPlanStepStatus,
) -> termloop_core::AgentPlanStepStatus {
    match status {
        termloop_contract::current::AgentPlanStepStatus::Pending => {
            termloop_core::AgentPlanStepStatus::Pending
        }
        termloop_contract::current::AgentPlanStepStatus::InProgress => {
            termloop_core::AgentPlanStepStatus::InProgress
        }
        termloop_contract::current::AgentPlanStepStatus::Completed => {
            termloop_core::AgentPlanStepStatus::Completed
        }
    }
}

fn agent_plan_update(
    plan: termloop_contract::current::AgentPlanObservation,
) -> termloop_core::AgentPlanUpdate {
    use termloop_contract::current::AgentPlanObservation;
    match plan {
        AgentPlanObservation::Replace { explanation, steps } => {
            termloop_core::AgentPlanUpdate::Replace(termloop_core::AgentPlan {
                source: termloop_core::AgentPlanSource::LaunchScopedHook,
                explanation,
                steps: steps
                    .into_iter()
                    .map(|step| termloop_core::AgentPlanStep {
                        text: step.text,
                        status: agent_plan_step_status(step.status),
                    })
                    .collect(),
            })
        }
        AgentPlanObservation::UpsertTask {
            task_id,
            text,
            status,
        } => termloop_core::AgentPlanUpdate::UpsertTask {
            task_id,
            text,
            status: agent_plan_step_status(status),
        },
        AgentPlanObservation::SetTaskStatus { task_id, status } => {
            termloop_core::AgentPlanUpdate::SetTaskStatus {
                task_id,
                status: agent_plan_step_status(status),
            }
        }
        AgentPlanObservation::RemoveTask { task_id } => {
            termloop_core::AgentPlanUpdate::RemoveTask { task_id }
        }
    }
}

pub(in crate::app) struct DispatchOutcome {
    pub(in crate::app) response: String,
    pub(in crate::app) subscription: Option<Vec<ProjectionTopic>>,
    pub(in crate::app) project_demands: Option<Vec<String>>,
    pub(in crate::app) post_response: Option<PostResponseAction>,
}

pub(in crate::app) enum PostResponseAction {
    DeliverGeneratedInitialInput { session_id: String },
}

pub(in crate::app) async fn dispatch(
    request: ControlRequest,
    state: &AppState,
    origin: ConnectionOrigin,
    remote_credential: Option<&super::RemoteControlCredential>,
) -> DispatchOutcome {
    let operation = Arc::<str>::from(request.method.as_str());
    let scope = request_scope(&request, state, remote_credential);
    let role = scope_name(scope);
    let started = Instant::now();
    let outcome = in_operation(
        "control",
        role,
        operation.clone(),
        dispatch_inner(request, state, scope, origin),
    )
    .await;
    record_operation_duration("control", role, &operation, started.elapsed());
    outcome
}

pub(super) fn request_scope(
    request: &ControlRequest,
    state: &AppState,
    remote_credential: Option<&super::RemoteControlCredential>,
) -> Option<ClientScope> {
    if let Some(remote) = remote_credential {
        return constant_time_equal(request.token.as_bytes(), remote.token.as_bytes())
            .then_some(remote.scope);
    }
    if constant_time_equal(request.token.as_bytes(), state.control_token.as_bytes()) {
        Some(ClientScope::Full)
    } else if constant_time_equal(request.token.as_bytes(), state.read_only_token.as_bytes()) {
        Some(ClientScope::ReadOnly)
    } else if state.companion_credentials.matches(&request.token) {
        Some(ClientScope::Companion)
    } else if request.method == "agent.observe" {
        Some(ClientScope::Hook)
    } else {
        None
    }
}

fn scope_name(scope: Option<ClientScope>) -> &'static str {
    match scope {
        Some(ClientScope::Full) => "full",
        Some(ClientScope::ReadOnly) => "readOnly",
        Some(ClientScope::Companion) => "companion",
        Some(ClientScope::Hook) => "hook",
        None => "unauthenticated",
    }
}

async fn dispatch_inner(
    request: ControlRequest,
    state: &AppState,
    scope: Option<ClientScope>,
    origin: ConnectionOrigin,
) -> DispatchOutcome {
    let requested_method = request.method.clone();
    let request_token = request.token.clone();
    let requested_project_demands = (request.method == "control.subscribe").then(|| {
        request
            .params
            .get("projectIds")
            .and_then(serde_json::Value::as_array)
            .map(|projects| {
                projects
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let mut post_response = None;
    if scope == Some(ClientScope::Companion) {
        super::super::companion_supervisor::observe_request(state).await;
    }
    let response = if request.id.is_empty() || request.id.len() > 128 {
        response_error(request.id, ErrorCode::InvalidMessage, "invalid request id")
    } else if request.token.len() < 32 || request.token.len() > 256 || scope.is_none() {
        response_error(request.id, ErrorCode::Unauthenticated, "invalid credential")
    } else if !request.params.is_object() {
        response_error(
            request.id,
            ErrorCode::InvalidMessage,
            "params must be an object",
        )
    } else if !protocol::METHODS.contains(&request.method.as_str()) {
        response_error(request.id, ErrorCode::MethodNotFound, "method not found")
    } else if !protocol::validate_method_params(&request.method, &request.params) {
        response_error(
            request.id,
            ErrorCode::InvalidMessage,
            "params do not match the method schema",
        )
    } else if !scope.is_some_and(|scope| scope_allows_method(scope, &request.method)) {
        response_error(
            request.id,
            ErrorCode::CapabilityDenied,
            "credential does not allow this method",
        )
    } else if !origin_allows_method(origin, &request.method) {
        response_error(
            request.id,
            ErrorCode::CapabilityDenied,
            "connection origin does not allow this method",
        )
    } else {
        let cleanup_expected_proof = request
            .params
            .get("expectedManagedWorktreeOperationId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let cleanup_expected_generation = request
            .params
            .get("expectedWorktreeGeneration")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default();
        let requested_task_id = request
            .params
            .get("taskId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let requested_project_id = request
            .params
            .get("projectId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let task_launch_deadline = Instant::now() + Duration::from_secs(5);
        let agent_fork_deadline = Instant::now() + Duration::from_secs(10);
        let result = match request.method.as_str() {
            "system.version" => Ok(
                json!({ "product": "TermLoop", "version": env!("CARGO_PKG_VERSION"), "protocolVersion": CONTRACT_IDENTITY }),
            ),
            "system.capabilities" => Ok(
                json!({ "methods": protocol::METHODS, "events": protocol::EVENTS, "terminalDataPlane": "binary-websocket" }),
            ),
            "system.ping" => Ok(json!({ "pong": true })),
            "system.defaultProjectsRoot" => {
                match tokio::task::spawn_blocking(termloop_platform::default_projects_root).await {
                    Ok(result) => result
                        .map(|path| json!({ "path": path }))
                        .map_err(|error| termloop_core::CoreError::Terminal(error.to_string())),
                    Err(error) => Err(termloop_core::CoreError::Terminal(error.to_string())),
                }
            }
            "system.browseDirectory" => {
                let params =
                    serde_json::from_value::<protocol::DirectoryBrowseParams>(request.params)
                        .expect("validated directory browse params");
                match tokio::task::spawn_blocking(move || {
                    termloop_platform::browse_directory(std::path::Path::new(&params.path))
                })
                .await
                {
                    Ok(result) => result
                        .map(|directory| json!({
                            "path": directory.path,
                            "parentPath": directory.parent_path,
                            "entries": directory.entries.into_iter().map(|entry| json!({
                                "name": entry.name,
                                "path": entry.path,
                                "kind": match entry.kind {
                                    termloop_platform::BrowsedDirectoryKind::Directory => "directory",
                                    termloop_platform::BrowsedDirectoryKind::SymlinkDirectory => "symlinkDirectory",
                                },
                            })).collect::<Vec<_>>(),
                        }))
                        .map_err(|error| termloop_core::CoreError::Terminal(error.to_string())),
                    Err(error) => Err(termloop_core::CoreError::Terminal(error.to_string())),
                }
            }
            "attachment.beginUpload" => {
                let params =
                    serde_json::from_value::<protocol::AttachmentBeginUploadParams>(request.params)
                        .expect("validated attachment upload params");
                state
                    .attachments
                    .begin_upload(params)
                    .and_then(|result| {
                        serde_json::to_value(result).map_err(|error| error.to_string())
                    })
                    .map_err(termloop_core::CoreError::Terminal)
            }
            "system.keepAwake.get" => {
                let status = super::super::keep_awake::reconcile(state).await;
                serde_json::to_value(status)
                    .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))
            }
            "system.keepAwake.set" => {
                let params = serde_json::from_value::<protocol::KeepAwakeSetParams>(request.params)
                    .expect("validated keep-awake params");
                let expires_at_epoch_ms = (params.mode != protocol::KeepAwakeMode::Off)
                    .then_some(params.duration_seconds)
                    .flatten()
                    .map(|duration| {
                        super::super::current_epoch_ms()
                            .saturating_add(duration.saturating_mul(1_000))
                    });
                let preference = termloop_core::KeepAwakePreference {
                    mode: super::super::keep_awake::core_mode(&params.mode),
                    keep_display_awake: params.keep_display_awake,
                    expires_at_epoch_ms,
                };
                let written = {
                    let mut core = state.core.lock().await;
                    core.set_keep_awake_preference(preference)
                        .map(|()| core.state_revision())
                };
                match written {
                    Err(error) => Err(error),
                    Ok(state_revision) => {
                        // Applies the new preference before replying, so the
                        // returned status describes the hold the caller
                        // actually gets rather than the one just requested.
                        let status = super::super::keep_awake::reconcile(state).await;
                        super::super::keep_awake::publish_invalidation(state, state_revision).await;
                        serde_json::to_value(status)
                            .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))
                    }
                }
            }
            "skill.catalogGet" => get_skill_catalog(request.params, state).await,
            "skill.deploymentSet" => set_skill_deployment(request.params, state).await,
            "skill.definitionGet" => get_skill_definition(request.params, state).await,
            "skill.definitionSave" => save_skill_definition(request.params, state).await,
            "contextBank.catalogGet" => get_context_bank_catalog(request.params, state).await,
            "contextBank.fileGet" => get_context_bank_file(request.params, state).await,
            "contextBank.fileSave" => save_context_bank_file(request.params, state).await,
            "contextBank.siblingConflictResolve" => {
                resolve_context_bank_sibling_conflict(request.params, state).await
            }
            "system.shutdown" => {
                // Reply success first: the notifier is scheduled behind a
                // short grace delay so the response reaches the requesting
                // client before axum begins its graceful shutdown. The Full
                // scope requirement is enforced by scope_allows_method above.
                super::super::schedule_control_shutdown(state.shutdown_requests.clone());
                Ok(json!({ "accepted": true }))
            }
            "access.status" => serde_json::to_value(state.access_plane.status())
                .map_err(|error| termloop_core::CoreError::Terminal(error.to_string())),
            "access.enable" => {
                let params = serde_json::from_value::<protocol::AccessEnableParams>(request.params)
                    .expect("validated access enable params");
                state
                    .access_plane
                    .enable(state.clone(), params.port)
                    .await
                    .and_then(|status| {
                        serde_json::to_value(status).map_err(|error| error.to_string())
                    })
                    .map_err(termloop_core::CoreError::Terminal)
            }
            "access.disable" => state
                .access_plane
                .disable()
                .await
                .and_then(|status| serde_json::to_value(status).map_err(|error| error.to_string()))
                .map_err(termloop_core::CoreError::Terminal),
            "access.pairCreate" => {
                let params =
                    serde_json::from_value::<protocol::AccessPairCreateParams>(request.params)
                        .expect("validated access pairing params");
                state
                    .access_plane
                    .create_pairing(params.name, params.scope)
                    .await
                    .and_then(|invitation| {
                        serde_json::to_value(invitation).map_err(|error| error.to_string())
                    })
                    .map_err(termloop_core::CoreError::Terminal)
            }
            "access.deviceList" => serde_json::to_value(state.access_plane.devices())
                .map_err(|error| termloop_core::CoreError::Terminal(error.to_string())),
            "access.deviceRevoke" => {
                let params =
                    serde_json::from_value::<protocol::AccessDeviceRevokeParams>(request.params)
                        .expect("validated access revoke params");
                state
                    .access_plane
                    .revoke(&params.device_id)
                    .map(|revoked| json!({ "revoked": revoked }))
                    .map_err(termloop_core::CoreError::Terminal)
            }
            "companion.wakeNext" => {
                let params =
                    serde_json::from_value::<protocol::CompanionWakeNextParams>(request.params)
                        .expect("validated Companion wake params");
                serde_json::to_value(state.companion_wakes.next(params.wait_milliseconds).await)
                    .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))
            }
            "companion.stewardWake" => {
                let params =
                    serde_json::from_value::<protocol::CompanionStewardWakeParams>(request.params)
                        .expect("validated Companion Steward wake params");
                let wake = state
                    .companion_wakes
                    .in_flight_wake(&params.project_id, params.generation)
                    .ok_or(termloop_core::CoreError::RevisionConflict);
                let admission = {
                    let core = state.core.lock().await;
                    core.current_enabled_steward_wake(&params.project_id)
                        .filter(|wake| wake.generation == params.generation)
                        .map(|wake| wake.agent_id)
                        .ok_or(termloop_core::CoreError::RevisionConflict)
                };
                match (admission, wake) {
                    (Err(error), _) | (_, Err(error)) => Err(error),
                    (Ok(agent_id), Ok(wake)) => {
                        let proven = state
                            .agent_capabilities
                            .iter()
                            .find(|capability| capability.agent_id == agent_id)
                            .is_some_and(|capability| capability.available);
                        if !proven {
                            Err(termloop_core::CoreError::AgentCapabilityUnproven)
                        } else {
                            let result = super::handlers::schedule_current_steward(
                                params.project_id.clone(),
                                params.generation,
                                wake.wake_id,
                                wake.reason,
                                state.clone(),
                            )
                            .await;
                            result.map(|admission| match admission {
                                StewardWakeAdmission::Admitted => {
                                    json!({"admitted":true,"coalesced":false})
                                }
                                StewardWakeAdmission::Coalesced => {
                                    json!({"admitted":false,"coalesced":true})
                                }
                            })
                        }
                    }
                }
            }
            "control.subscribe" => {
                let params = serde_json::from_value::<ControlSubscribeParams>(request.params)
                    .expect("validated subscribe params");
                Ok(serde_json::to_value(ControlSubscribeResult {
                    topics: params.topics,
                    state_revision: state.core_projection.state_revision(),
                    observation_sequence: state.core_projection.observation_sequence(),
                    runtime_epoch: state.runtime_epoch,
                })
                .expect("subscribe result is serializable"))
            }
            "control.cancel" => Ok(json!({ "cancelled": false })),
            "agent.observe" => {
                let params = serde_json::from_value::<AgentObserveParams>(request.params)
                    .expect("validated observation params");
                let session_id = params.session_id.clone();
                let input = termloop_core::ProviderHookObservationInput {
                    event_name: params.event_name,
                    notification_type: params.notification_type,
                    native_session_id: params.native_session_id,
                    provider_model_id: params.provider_model_id,
                    permission_mode: params.permission_mode,
                    reasoning_level: params.effort_level,
                    transcript_path: params.transcript_path,
                    prompt_id: params.prompt_id,
                    plan: params.plan.map(agent_plan_update),
                };
                let mut core = state.core.lock().await;
                match core.next_observation_sequence() {
                    Err(error) => Err(error),
                    Ok(observation_sequence) => {
                        let outcome = core.record_provider_hook_observation(
                            &request_token,
                            &session_id,
                            input,
                            observation_sequence,
                            current_epoch_ms(),
                        );
                        match outcome {
                            Err(error) => Err(error),
                            Ok(outcome) => {
                                super::super::acknowledge_confirmed_steward_wakes(
                                    &mut core,
                                    &state.companion_wakes,
                                );
                                if outcome.session_started
                                    && !outcome.provider_session_replaced
                                    && core.pending_generated_input_after_hook_response(&session_id)
                                {
                                    post_response =
                                        Some(PostResponseAction::DeliverGeneratedInitialInput {
                                            session_id: session_id.clone(),
                                        });
                                }
                                let replacement_runtime = if outcome.provider_session_replaced {
                                    core.terminate_session(json!({ "sessionId": session_id }))
                                        .ok()
                                        .and_then(|(_, runtime)| runtime)
                                } else {
                                    None
                                };
                                let state_revision = core.state_revision();
                                drop(core);
                                if let Some(runtime) = replacement_runtime {
                                    tokio::task::spawn_blocking(move || drop(runtime));
                                }
                                state
                                    .observation_sequence
                                    .fetch_max(observation_sequence, Ordering::Relaxed);
                                if outcome.provider_session_replaced {
                                    let _ =
                                        state.invalidation_requests.try_send(InvalidationRequest {
                                            topics: vec![
                                                ProjectionTopic::AgentStatus,
                                                ProjectionTopic::Session,
                                            ],
                                            state_revision,
                                            observation_sequence,
                                        });
                                    Err(termloop_core::CoreError::ResumeRefReplacement)
                                } else {
                                    let status_changed = outcome.status_changed;
                                    let session_changed = outcome.session_changed;
                                    if status_changed || session_changed {
                                        let mut topics = Vec::new();
                                        if status_changed {
                                            topics.push(ProjectionTopic::AgentStatus);
                                            // A Worker's turn ending is what
                                            // makes it wakeable again, and the
                                            // Routine loop is asleep until
                                            // told that something moved.
                                            state.tracker_runtime_wake.notify_one();
                                        }
                                        if session_changed {
                                            topics.push(ProjectionTopic::Session);
                                        }
                                        let _ = state.invalidation_requests.try_send(
                                            InvalidationRequest {
                                                topics,
                                                state_revision,
                                                observation_sequence,
                                            },
                                        );
                                    }
                                    Ok(json!({ "accepted": true }))
                                }
                            }
                        }
                    }
                }
            }
            "agent.capabilityList" => Ok(serde_json::Value::Array(
                state
                    .agent_capabilities
                    .iter()
                    .map(|capability| {
                        json!({
                            "agent_id": capability.agent_id,
                            "label": capability.label,
                            "available": capability.available,
                            "version": capability.version,
                            "integration_level": capability.integration_level,
                            "degraded_reason": capability.degraded_reason,
                            "models": capability.models,
                            "permissions": capability.permissions,
                            "reasoning": capability.reasoning,
                            "observation_supported": capability.observation_supported,
                            "quick_action_supported": capability.quick_action_supported,
                            "tracked_helpers_supported": capability.tracked_helpers_supported,
                            "resume_supported": capability.resume_supported,
                            "native_fork_supported": capability.native_fork_supported,
                        })
                    })
                    .collect(),
            )),
            "steward.configurationGet" => {
                let mut core = state.core.lock().await;
                let project_id = request
                    .params
                    .get("projectId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                core.handle("steward.configurationGet", request.params)
                    .map(|mut result| {
                        let executor_session_id = result["configuration"]["executorSessionId"]
                            .as_str()
                            .map(str::to_owned);
                        result["supervisorAvailability"] =
                            json!(state.companion_status.availability().wire_name());
                        result["presence"] = json!({
                            "lastActivityAtEpochMs": executor_session_id.as_deref().and_then(|session_id| {
                                state.steward_presence.last_activity(session_id, state.runtime_epoch)
                            }),
                            "activeCommandLabel": state.steward_presence.active_command(&project_id),
                            "pendingProposal": core.companion_has_pending_proposal(&project_id),
                        });
                        result
                    })
            }
            "steward.configurationSet" => set_steward_configuration(request.params, state).await,
            "steward.configurationDelete" => {
                delete_steward_configuration(request.params, state).await
            }
            "worker.configurationList" => {
                let mut core = state.core.lock().await;
                core.handle("worker.configurationList", request.params)
            }
            "worker.configurationCreate" => {
                create_worker_configuration(request.params, state).await
            }
            "worker.configurationUpdate" => {
                update_worker_configuration(request.params, state).await
            }
            "worker.configurationDelete" => {
                delete_worker_configuration(request.params, state).await
            }
            "routine.runNow" => {
                let params =
                    serde_json::from_value::<protocol::RoutineRunNowParams>(request.params)
                        .expect("validated Routine run-now params");
                let mut core = state.core.lock().await;
                let now_epoch_ms = current_epoch_ms();
                let result = match params.task_id.as_deref() {
                    Some(task_id) => {
                        core.run_task_routine_now(&params.routine_id, task_id, now_epoch_ms)
                    }
                    None => core.run_routine_now(&params.routine_id, now_epoch_ms),
                };
                match result {
                    Ok(_) => {
                        state.tracker_runtime_wake.notify_one();
                        Ok(json!({ "accepted": true }))
                    }
                    Err(error) => Err(error),
                }
            }
            "taskSource.list" => super::task_source::list(request.params, state).await,
            "taskSource.boardList" => super::task_source::board_list(request.params, state).await,
            "taskSource.boardListStored" => {
                super::task_source::board_list_stored(request.params, state).await
            }
            "taskSource.statusList" => super::task_source::status_list(request.params, state).await,
            "taskSource.statusListStored" => {
                super::task_source::status_list_stored(request.params, state).await
            }
            "taskSource.create" => super::task_source::create(request.params, state).await,
            "taskSource.update" => super::task_source::update(request.params, state).await,
            "taskSource.credentialsSet" => {
                super::task_source::credentials_set(request.params, state).await
            }
            "taskSource.delete" => super::task_source::delete(request.params, state).await,
            "taskSource.refresh" => super::task_source::refresh(request.params, state).await,
            "taskSource.candidateList" => {
                super::task_source::candidate_list(request.params, state).await
            }
            "taskSource.candidateImport" => {
                super::task_source::candidate_import(request.params, state).await
            }
            "taskSource.candidateIgnore" => {
                super::task_source::candidate_ignore(request.params, state, true).await
            }
            "taskSource.candidateUnignore" => {
                super::task_source::candidate_ignore(request.params, state, false).await
            }
            "routine.configurationCreate" => {
                let params = serde_json::from_value::<protocol::RoutineConfigurationCreateParams>(
                    request.params,
                )
                .expect("validated Routine create params");
                let kind = match params.kind {
                    protocol::RoutineKind::Slack => "slack",
                    protocol::RoutineKind::Jira => "jira",
                    protocol::RoutineKind::Runtime => "runtime",
                    protocol::RoutineKind::Delivery => "delivery",
                    protocol::RoutineKind::CiPr => "ciPr",
                    protocol::RoutineKind::Custom => "custom",
                };
                let mut core = state.core.lock().await;
                let result = core.create_tracker_configuration(
                    termloop_platform::generate_opaque_id(),
                    &params.project_id,
                    kind,
                    routine_trigger_mode(params.trigger_mode),
                    params.name,
                    params.worker_id,
                    params.schedule_interval_seconds,
                    routine_action_handling(params.action_handling),
                    params.prompt,
                    params.steward_instructions,
                    params.expected_revision,
                    current_epoch_ms(),
                );
                publish_tracker_mutation(result, state, &core)
            }
            "routine.configurationUpdate" => {
                let params = serde_json::from_value::<protocol::RoutineConfigurationUpdateParams>(
                    request.params,
                )
                .expect("validated Routine update params");
                let mut core = state.core.lock().await;
                let result = core.update_tracker_configuration(
                    &params.routine_id,
                    routine_trigger_mode(params.trigger_mode),
                    params.name,
                    params.prompt,
                    params.steward_instructions,
                    params.worker_id,
                    params.enabled,
                    params.schedule_interval_seconds,
                    routine_action_handling(params.action_handling),
                    params.expected_revision,
                    current_epoch_ms(),
                );
                publish_tracker_mutation(result, state, &core)
            }
            "routine.contextUpdate" => {
                let params =
                    serde_json::from_value::<protocol::RoutineContextUpdateParams>(request.params)
                        .expect("validated Routine context update params");
                let mut core = state.core.lock().await;
                let result = core.update_routine_context(
                    &params.routine_id,
                    params.context_markdown,
                    params.expected_context_revision,
                    params.expected_revision,
                    current_epoch_ms(),
                );
                publish_tracker_mutation(result, state, &core)
            }
            "playbook.taskPositionSet" => {
                let params = serde_json::from_value::<protocol::PlaybookTaskPositionSetParams>(
                    request.params,
                )
                .expect("validated Playbook Task position params");
                let mut core = state.core.lock().await;
                let result = core.set_task_playbook_position(
                    &params.project_id,
                    &params.task_id,
                    params.passed_milestone_count,
                    params.expected_playbook_revision,
                    params.expected_revision,
                    current_epoch_ms(),
                );
                let state_revision = core.state_revision();
                drop(core);
                if result.is_ok() {
                    let _ = state.invalidation_requests.try_send(InvalidationRequest {
                        topics: vec![ProjectionTopic::Playbook],
                        state_revision,
                        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
                    });
                    state.tracker_runtime_wake.notify_one();
                }
                result
            }
            "playbook.update" => {
                let params =
                    serde_json::from_value::<protocol::PlaybookUpdateParams>(request.params)
                        .expect("validated Playbook update params");
                let project_id = params.project_id.clone();
                let preferred_agent = match params.preferred_worker_agent_id {
                    protocol::StewardAgentId::Claude => "claude",
                    protocol::StewardAgentId::Codex => "codex",
                };
                let preferred_worker_available =
                    state.agent_capabilities.iter().any(|capability| {
                        capability.agent_id == preferred_agent && capability.available
                    });
                let routine_capacity = params.milestones.len()
                    + params
                        .saved_pipelines
                        .iter()
                        .map(|pipeline| pipeline.milestones.len())
                        .sum::<usize>();
                let new_worker_id = termloop_platform::generate_opaque_id();
                let new_routine_ids = (0..routine_capacity)
                    .map(|_| termloop_platform::generate_opaque_id())
                    .collect::<Vec<_>>();
                let mut core = state.core.lock().await;
                let previous_revision = core.state_revision();
                let steward_was_enabled = core.current_enabled_steward_wake(&project_id).is_some();
                let result = core.update_playbook(
                    serde_json::to_value(params).expect("Playbook update params serialize"),
                    new_worker_id,
                    new_routine_ids,
                    preferred_worker_available,
                    current_epoch_ms(),
                );
                let state_revision = core.state_revision();
                let steward_enabled = !steward_was_enabled
                    && result.is_ok()
                    && core.current_enabled_steward_wake(&project_id).is_some();
                drop(core);
                if result.is_ok() && state_revision != previous_revision {
                    let mut topics = vec![
                        ProjectionTopic::Playbook,
                        ProjectionTopic::Routine,
                        ProjectionTopic::Worker,
                    ];
                    if steward_enabled {
                        topics.push(ProjectionTopic::Steward);
                    }
                    let _ = state.invalidation_requests.try_send(InvalidationRequest {
                        topics,
                        state_revision,
                        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
                    });
                    state.tracker_runtime_wake.notify_one();
                    if let Some(worker_id) = result
                        .as_ref()
                        .ok()
                        .and_then(|value| value["workerId"].as_str())
                        && let Err(error) = launch_current_worker(worker_id, state).await
                    {
                        tracing::warn!(%error, %worker_id, "Playbook Worker launch needs attention");
                    }
                    if steward_enabled {
                        super::super::companion_supervisor::enqueue_current_steward_wake(
                            state,
                            &project_id,
                            protocol::CompanionWakeReason::ConfigurationChanged,
                        )
                        .await;
                    }
                }
                result
            }
            "routine.configurationDelete" => {
                let params = serde_json::from_value::<protocol::RoutineConfigurationDeleteParams>(
                    request.params,
                )
                .expect("validated Routine delete params");
                let mut core = state.core.lock().await;
                let result =
                    core.delete_tracker_configuration(&params.routine_id, params.expected_revision);
                publish_tracker_mutation(result, state, &core)
            }
            "companion.transcriptAppend" => {
                let params = serde_json::from_value::<protocol::CompanionTranscriptAppendParams>(
                    request.params,
                )
                .expect("validated Companion transcript append params");
                let author = companion_transcript_author(scope.expect("authenticated scope"));
                let mut core = state.core.lock().await;
                let result = core.append_companion_message(
                    &params.project_id,
                    author,
                    "reply",
                    termloop_core::companion_integrations::transcript::CompanionMessageRefsInput::default(),
                    params.content,
                    current_epoch_ms(),
                );
                let state_revision = core.state_revision();
                drop(core);
                if result.is_ok() {
                    let _ = state.invalidation_requests.try_send(InvalidationRequest {
                        topics: vec![ProjectionTopic::Companion],
                        state_revision,
                        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
                    });
                    if scope == Some(ClientScope::Full) {
                        super::super::companion_supervisor::enqueue_current_steward_wake(
                            state,
                            &params.project_id,
                            protocol::CompanionWakeReason::UserMessage,
                        )
                        .await;
                    }
                }
                result
            }
            "companion.proposalRespond" => {
                let params = serde_json::from_value::<protocol::CompanionProposalRespondParams>(
                    request.params,
                )
                .expect("validated Companion proposal response params");
                let decision = match params.decision {
                    protocol::CompanionProposalDecision::Approve => "approve",
                    protocol::CompanionProposalDecision::Decline => "decline",
                };
                let mut core = state.core.lock().await;
                let result = core.respond_to_companion_proposal(
                    &params.project_id,
                    &params.proposal_message_id,
                    decision,
                    current_epoch_ms(),
                );
                let state_revision = core.state_revision();
                drop(core);
                if result.is_ok() {
                    let _ = state.invalidation_requests.try_send(InvalidationRequest {
                        topics: vec![ProjectionTopic::Companion],
                        state_revision,
                        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
                    });
                    super::super::companion_supervisor::enqueue_current_steward_wake(
                        state,
                        &params.project_id,
                        protocol::CompanionWakeReason::UserMessage,
                    )
                    .await;
                }
                result
            }
            "companion.suggestionAccept" => {
                let params = serde_json::from_value::<protocol::CompanionSuggestionAcceptParams>(
                    request.params,
                )
                .expect("validated Companion suggestion accept params");
                let mut core = state.core.lock().await;
                let result = core.accept_companion_suggestion(
                    &params.project_id,
                    &params.suggestion_message_id,
                    current_epoch_ms(),
                );
                let state_revision = core.state_revision();
                drop(core);
                if result.is_ok() {
                    let _ = state.invalidation_requests.try_send(InvalidationRequest {
                        topics: vec![ProjectionTopic::Companion],
                        state_revision,
                        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
                    });
                    super::super::companion_supervisor::enqueue_current_steward_wake(
                        state,
                        &params.project_id,
                        protocol::CompanionWakeReason::UserMessage,
                    )
                    .await;
                }
                result
            }
            "session.previewAgent" => preview_agent_session(request.params, state).await,
            "session.launchAgent" => launch_agent_session(request.params, state).await,
            "session.forkAgent" => {
                fork_agent_session(request.params, agent_fork_deadline, state).await
            }
            "session.repairProviderHistory" => repair_provider_history(request.params, state).await,
            "session.historyList" => list_session_history(request.params, state).await,
            "session.historyPreview" => session_history_preview(request.params, state).await,
            "session.previewHistoryResumeAgent" => {
                preview_session_history_resume(request.params, state).await
            }
            "session.resumeHistoryAgent" => launch_agent_session(request.params, state).await,
            "session.requestAskTo" => {
                let params =
                    serde_json::from_value::<protocol::SessionAgentAskToParams>(request.params)
                        .expect("validated Agent Ask-To request params");
                state
                    .core
                    .lock()
                    .await
                    .request_agent_ask_to(&params.session_id, &params.target_agent_id)
            }
            "session.requestHandoverTo" => {
                let params = serde_json::from_value::<protocol::SessionAgentHandoverToParams>(
                    request.params,
                )
                .expect("validated Agent handover request params");
                state
                    .core
                    .lock()
                    .await
                    .request_agent_handover_to(&params.session_id, &params.target_session_id)
            }
            "session.pasteImage" => paste_agent_image(request.params, state).await,
            "session.archive" => archive_session(request.params, state).await,
            "project.delete" => delete_project(request.params, state).await,
            "quickAction.preview" => preview_quick_action(request.params, state).await,
            "quickAction.launch" => launch_quick_action(request.params, state).await,
            "runConfiguration.improvePreview" => {
                preview_run_configuration_improver(request.params, state).await
            }
            "runConfiguration.improveLaunch" => {
                launch_run_configuration_improver(request.params, state).await
            }
            "assistantPrompt.improvePreview" => {
                preview_assistant_prompt_improver(request.params, state).await
            }
            "assistantPrompt.improveLaunch" => {
                launch_assistant_prompt_improver(request.params, state).await
            }
            "settings.improvePreview" => preview_settings_improver(request.params, state).await,
            "settings.improveLaunch" => launch_settings_improver(request.params, state).await,
            "configuration.versionRestore" => {
                restore_configuration_version(request.params, state).await
            }
            "task.launchTerminal" => {
                launch_task_session(request.params, false, task_launch_deadline, state).await
            }
            "task.previewAgent" => {
                preview_task_agent_session(request.params, task_launch_deadline, state).await
            }
            "task.launchAgent" => {
                launch_task_session(request.params, true, task_launch_deadline, state).await
            }
            "task.startRun" => {
                launch_task_run(request.params, false, task_launch_deadline, state).await
            }
            "task.restartRun" => {
                launch_task_run(request.params, true, task_launch_deadline, state).await
            }
            "project.startRun" => launch_project_run(request.params, false, state).await,
            "project.restartRun" => launch_project_run(request.params, true, state).await,
            "task.archive" => archive_task(request.params, state).await,
            "task.restore" => restore_task(request.params, state).await,
            "task.reopen" => reopen_task(request.params, state).await,
            "session.terminate" => terminate_session(request.params, state).await,
            "session.previewResumeAgent" => {
                preview_resume_agent_session(request.params, state).await
            }
            "session.resumeAgent" => resume_agent_session(request.params, state).await,
            "session.restartAgent" => restart_agent_session(request.params, state).await,
            "session.previewRelocateAgentToTask" => {
                preview_relocate_agent_session(request.params, task_launch_deadline, state).await
            }
            "session.relocateAgentToTask" => relocate_agent_session(request.params, state).await,
            "session.previewRelocateAgentToProject" => {
                preview_relocate_agent_to_project(request.params, state).await
            }
            "session.relocateAgentToProject" => relocate_agent_session(request.params, state).await,
            "session.restoreArchived" => restore_archived_session(request.params, state).await,
            "session.listDeleted" => list_deleted_sessions(request.params, state).await,
            "session.restoreDeleted" => restore_deleted_session(request.params, state).await,
            "session.restartAgentsForClientLaunch" => {
                restart_agents_for_client_launch(request.params, state).await
            }
            "session.close" => close_session(request.params, state).await,
            "task.bindBranch" => bind_task_branch(request.params, state).await,
            "task.provisionWorktree" => provision_task_worktree(request.params, state).await,
            "task.inspectWorktreeCleanup" => {
                inspect_task_worktree_cleanup(request.params, state).await
            }
            "task.worktreeChangeList" => task_worktree_change_list(request.params, state).await,
            "task.worktreeDiff" => task_worktree_diff(request.params, state).await,
            "task.worktreePreImage" => task_worktree_pre_image(request.params, state).await,
            "task.branchCommitSummaryList" => {
                task_branch_commit_summary_list(request.params, state).await
            }
            "task.branchCommitList" => task_branch_commit_list(request.params, state).await,
            "task.branchCommitChangeList" => {
                task_branch_commit_change_list(request.params, state).await
            }
            "task.branchCommitDiff" => task_branch_commit_diff(request.params, state).await,
            "task.inspectWorktreeRepair" => {
                inspect_task_worktree_repair(request.params, state).await
            }
            "task.cleanupWorktree" => cleanup_task_worktree(request.params, state).await,
            "task.forgetStaleWorktree" => {
                resolve_stale_task_worktree(request.params, false, state).await
            }
            "task.discardStaleWorktree" => {
                resolve_stale_task_worktree(request.params, true, state).await
            }
            "task.repairWorktree" => repair_task_worktree(request.params, state).await,
            "task.dismissWorktreeRepair" => {
                dismiss_task_worktree_repair(request.params, state).await
            }
            "task.dismissWorktreeProvisioning" => {
                dismiss_task_worktree_provisioning(request.params, state).await
            }
            "task.create" => {
                super::super::task_automation::create_task(request.params, state).await
            }
            "task.list" => {
                let core = state.core.lock().await;
                core.list_tasks_current(request.params)
            }
            "project.listLocalBranches" => project_list_local_branches(request.params, state).await,
            "project.worktreeSummary" => project_worktree_summary(request.params, state).await,
            "project.worktreeChangeList" => {
                project_worktree_change_list(request.params, state).await
            }
            "project.worktreeDiff" => project_worktree_diff(request.params, state).await,
            "project.worktreePreImage" => project_worktree_pre_image(request.params, state).await,
            "gitHost.pullRequestList" => git_host_pull_request_list(request.params, state).await,
            "gitHost.pullRequestChangeList" => {
                git_host_pull_request_change_list(request.params, state).await
            }
            "gitHost.pullRequestDiff" => git_host_pull_request_diff(request.params, state).await,
            _ => {
                let mut core = state.core.lock().await;
                let previous_revision = core.state_revision();
                let result = core.handle(&request.method, request.params);
                let current_revision = core.state_revision();
                drop(core);
                let topics = mutation_topics(&request.method);
                if result.is_ok() && current_revision != previous_revision && !topics.is_empty() {
                    let _ = state.invalidation_requests.try_send(InvalidationRequest {
                        topics,
                        state_revision: current_revision,
                        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
                    });
                }
                result
            }
        };
        if result.is_ok()
            && matches!(
                request.method.as_str(),
                "routine.configurationUpdate"
                    | "routine.contextUpdate"
                    | "routine.configurationDelete"
                    | "playbook.update"
                    | "project.delete"
            )
        {
            let core = state.core.lock().await;
            if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
                capabilities.retain_current(&core, current_epoch_ms());
            }
        }
        if result.is_ok()
            && request.method == "project.delete"
            && let Some(project_id) = requested_project_id.as_deref()
        {
            state.companion_wakes.discard(project_id);
        }
        if result.is_ok()
            && matches!(
                request.method.as_str(),
                "project.delete"
                    | "task.provisionWorktree"
                    | "task.dismissWorktreeProvisioning"
                    | "task.cleanupWorktree"
                    | "task.forgetStaleWorktree"
                    | "task.discardStaleWorktree"
                    | "task.repairWorktree"
                    | "task.dismissWorktreeRepair"
                    | "task.delete"
                    | "task.deleteArchived"
            )
        {
            refresh_all_health_demands(state).await;
        }
        if let Ok(value) = &result
            && request.method == "session.launchTerminal"
            && let Some(cwd) = value
                .get("process")
                .and_then(|process| process.get("cwd"))
                .and_then(serde_json::Value::as_str)
        {
            refresh_task_presence_for_cwd(state, cwd).await;
        }
        if result.is_ok()
            && request.method == "task.provisionWorktree"
            && let Some(task_id) = requested_task_id.as_deref()
        {
            invalidate_automatic_git_host_task(state, task_id).await;
        } else if result.is_ok()
            && request.method == "task.reopen"
            && let Some(task_id) = requested_task_id.as_deref()
        {
            invalidate_automatic_git_host_task(state, task_id).await;
        } else if result.is_ok()
            && matches!(
                request.method.as_str(),
                "task.delete" | "task.deleteArchived"
            )
        {
            let state_revision = state.core_projection.state_revision();
            let _ = state.invalidations.send(ProjectionInvalidatedPayload {
                topics: vec![ProjectionTopic::GitHost],
                state_revision,
                observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
                entity_scopes: None,
            });
        }
        match result {
            Ok(result) if protocol::validate_method_result(&request.method, &result) => {
                ControlResponse {
                    id: request.id,
                    ok: true,
                    result: Some(result),
                    error: None,
                }
            }
            Ok(_) => response_error(
                request.id,
                ErrorCode::Internal,
                "method result violated the protocol schema",
            ),
            Err(termloop_core::CoreError::MethodNotFound) => {
                response_error(request.id, ErrorCode::MethodNotFound, "method not found")
            }
            Err(termloop_core::CoreError::InvalidParams(message)) => {
                response_error(request.id, ErrorCode::InvalidMessage, &message)
            }
            Err(termloop_core::CoreError::NotFound) => {
                response_error(request.id, ErrorCode::NotFound, "record not found")
            }
            Err(termloop_core::CoreError::RevisionConflict) => response_error(
                request.id,
                ErrorCode::Conflict,
                "state revision changed; refresh and try again",
            ),
            Err(termloop_core::CoreError::BranchNotFound) => {
                response_error(request.id, ErrorCode::NotFound, "branch not found")
            }
            Err(termloop_core::CoreError::BranchHeldByTask { task_id }) => response_conflict(
                request.id,
                ProtocolErrorDetails::BranchHeldByTask { task_id },
                "branch is held by another Task",
            ),
            Err(termloop_core::CoreError::TaskBranchAlreadyBound { task_id }) => response_conflict(
                request.id,
                ProtocolErrorDetails::TaskBranchAlreadyBound { task_id },
                "Task already has a different branch binding",
            ),
            Err(termloop_core::CoreError::WorktreePathHeldByTask { task_id }) => response_conflict(
                request.id,
                ProtocolErrorDetails::WorktreePathHeldByTask { task_id },
                "worktree path is held by another Task",
            ),
            Err(termloop_core::CoreError::ProvisioningAlreadyInProgress { operation_id }) => {
                response_conflict(
                    request.id,
                    ProtocolErrorDetails::ProvisioningAlreadyInProgress { operation_id },
                    "another provisioning specification is already in progress",
                )
            }
            Err(termloop_core::CoreError::OperationIdReused { operation_id }) => response_conflict(
                request.id,
                ProtocolErrorDetails::OperationIdReused { operation_id },
                "operation ID was reused with another specification",
            ),
            Err(termloop_core::CoreError::BranchCheckedOutElsewhere { worktree_path }) => {
                response_conflict(
                    request.id,
                    ProtocolErrorDetails::BranchCheckedOutElsewhere { worktree_path },
                    "branch is already checked out in another worktree",
                )
            }
            Err(termloop_core::CoreError::WorktreeRecoveryAttention { operation_id }) => {
                response_conflict(
                    request.id,
                    ProtocolErrorDetails::WorktreeRecoveryAttention { operation_id },
                    "worktree recovery needs attention",
                )
            }
            Err(termloop_core::CoreError::TaskWorktreeCleanupRequired { task_id }) => {
                response_conflict(
                    request.id,
                    ProtocolErrorDetails::TaskWorktreeCleanupRequired { task_id },
                    "Task worktree must be cleaned up before deletion",
                )
            }
            Err(termloop_core::CoreError::TaskArchived { task_id }) => response_conflict(
                request.id,
                ProtocolErrorDetails::TaskArchived { task_id },
                "Task is archived; restore it before changing active workflow state",
            ),
            Err(termloop_core::CoreError::TaskNotArchived { task_id }) => response_conflict(
                request.id,
                ProtocolErrorDetails::TaskNotArchived { task_id },
                "Task is not archived",
            ),
            Err(termloop_core::CoreError::ArchivePreviewStale { task_id }) => response_conflict(
                request.id,
                ProtocolErrorDetails::ArchivePreviewStale { task_id },
                "Task archive preview is stale; inspect again",
            ),
            Err(termloop_core::CoreError::ArchiveRefused {
                task_id,
                blockers,
                session_ids,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::ArchiveRefused {
                    task_id,
                    blockers,
                    session_ids,
                },
                "Task archive was refused by the current safety inspection",
            ),
            Err(termloop_core::CoreError::ArchiveInProgress {
                task_id,
                operation_id,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::ArchiveInProgress {
                    task_id,
                    operation_id,
                },
                "Task archive is already in progress",
            ),
            Err(termloop_core::CoreError::ArchiveRecoveryAttention {
                task_id,
                operation_id,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::ArchiveRecoveryAttention {
                    task_id,
                    operation_id,
                },
                "Task archive needs recovery attention",
            ),
            Err(termloop_core::CoreError::SessionSuspendedByTaskArchive { session_id }) => {
                response_conflict(
                    request.id,
                    ProtocolErrorDetails::SessionSuspendedByTaskArchive { session_id },
                    "Session is suspended by a Task archive",
                )
            }
            Err(termloop_core::CoreError::CleanupInProgress {
                task_id,
                operation_id,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::CleanupInProgress {
                    task_id,
                    operation_id,
                },
                "worktree cleanup is already in progress",
            ),
            Err(termloop_core::CoreError::WorktreeCleanupRefused {
                task_id,
                expected_managed_worktree_operation_id,
                expected_worktree_generation,
                blockers,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::WorktreeCleanupRefused {
                    task_id,
                    expected_managed_worktree_operation_id,
                    expected_worktree_generation,
                    blockers: blockers
                        .into_iter()
                        .map(|blocker| {
                            serde_json::from_value(json!(
                                termloop_core::task_worktree::cleanup_blocker_name(&blocker)
                            ))
                            .expect("core cleanup blocker matches the generated contract")
                        })
                        .collect(),
                },
                "worktree cleanup was refused",
            ),
            Err(termloop_core::CoreError::ManagedWorktreeProofChanged {
                task_id,
                current_managed_worktree_operation_id,
                current_worktree_generation,
            }) => {
                if requested_method == "task.inspectWorktreeCleanup"
                    || requested_method == "task.worktreeChangeList"
                    || requested_method == "task.worktreeDiff"
                    || requested_method == "task.worktreePreImage"
                {
                    response_error(
                        request.id,
                        ErrorCode::Conflict,
                        "worktree changed during inspection; inspect again",
                    )
                } else {
                    response_conflict(
                        request.id,
                        ProtocolErrorDetails::ManagedWorktreeProofChanged {
                            task_id,
                            expected_managed_worktree_operation_id: cleanup_expected_proof,
                            expected_worktree_generation: cleanup_expected_generation,
                            current_managed_worktree_operation_id,
                            current_worktree_generation,
                        },
                        "managed worktree proof changed",
                    )
                }
            }
            Err(termloop_core::CoreError::WorktreeCleanupRecoveryAttention { operation_id }) => {
                response_conflict(
                    request.id,
                    ProtocolErrorDetails::WorktreeCleanupRecoveryAttention { operation_id },
                    "worktree cleanup needs recovery attention",
                )
            }
            Err(termloop_core::CoreError::StaleDisposalInProgress {
                task_id,
                operation_id,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::StaleDisposalInProgress {
                    task_id,
                    operation_id,
                },
                "stale worktree resolution is already in progress",
            ),
            Err(termloop_core::CoreError::WorktreeStaleResolutionRefused {
                task_id,
                expected_managed_worktree_operation_id,
                expected_worktree_generation,
                blockers,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::WorktreeStaleResolutionRefused {
                    task_id,
                    expected_managed_worktree_operation_id,
                    expected_worktree_generation,
                    blockers: blockers
                        .into_iter()
                        .map(|blocker| {
                            serde_json::from_value(json!(
                                termloop_core::task_worktree::stale_resolution_blocker_name(
                                    &blocker
                                )
                            ))
                            .expect("core stale blocker matches the generated contract")
                        })
                        .collect(),
                },
                "stale worktree resolution was refused",
            ),
            Err(termloop_core::CoreError::WorktreeStaleDisposalRecoveryAttention {
                task_id,
                operation_id,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::WorktreeStaleDisposalRecoveryAttention {
                    task_id,
                    operation_id,
                },
                "stale worktree disposal needs recovery attention",
            ),
            Err(termloop_core::CoreError::TaskWorktreeRequired { task_id }) => response_conflict(
                request.id,
                ProtocolErrorDetails::WorktreeRequired { task_id },
                "Task requires a managed worktree",
            ),
            Err(termloop_core::CoreError::TaskWorktreeUnavailable { task_id, reason }) => {
                let reason = match reason {
                    termloop_core::TaskWorktreeUnavailableReason::ManagedProofMissing => {
                        protocol::TaskWorktreeUnavailableReason::ManagedProofMissing
                    }
                    termloop_core::TaskWorktreeUnavailableReason::ManagedProofMismatch => {
                        protocol::TaskWorktreeUnavailableReason::ManagedProofMismatch
                    }
                    termloop_core::TaskWorktreeUnavailableReason::PathAbsent => {
                        protocol::TaskWorktreeUnavailableReason::PathAbsent
                    }
                    termloop_core::TaskWorktreeUnavailableReason::PathReplaced => {
                        protocol::TaskWorktreeUnavailableReason::PathReplaced
                    }
                    termloop_core::TaskWorktreeUnavailableReason::RegistrationAbsent => {
                        protocol::TaskWorktreeUnavailableReason::RegistrationAbsent
                    }
                    termloop_core::TaskWorktreeUnavailableReason::RegistrationMismatch => {
                        protocol::TaskWorktreeUnavailableReason::RegistrationMismatch
                    }
                    termloop_core::TaskWorktreeUnavailableReason::HeadMismatch => {
                        protocol::TaskWorktreeUnavailableReason::HeadMismatch
                    }
                    termloop_core::TaskWorktreeUnavailableReason::ObservationUnknown => {
                        protocol::TaskWorktreeUnavailableReason::ObservationUnknown
                    }
                    termloop_core::TaskWorktreeUnavailableReason::RepositoryUnavailable => {
                        protocol::TaskWorktreeUnavailableReason::RepositoryUnavailable
                    }
                    termloop_core::TaskWorktreeUnavailableReason::PermissionDenied => {
                        protocol::TaskWorktreeUnavailableReason::PermissionDenied
                    }
                    termloop_core::TaskWorktreeUnavailableReason::UnsupportedGit => {
                        protocol::TaskWorktreeUnavailableReason::UnsupportedGit
                    }
                    termloop_core::TaskWorktreeUnavailableReason::Timeout => {
                        protocol::TaskWorktreeUnavailableReason::Timeout
                    }
                    termloop_core::TaskWorktreeUnavailableReason::OutputLimit => {
                        protocol::TaskWorktreeUnavailableReason::OutputLimit
                    }
                    termloop_core::TaskWorktreeUnavailableReason::RepairRecoveryAttention => {
                        protocol::TaskWorktreeUnavailableReason::RepairRecoveryAttention
                    }
                };
                response_conflict(
                    request.id,
                    ProtocolErrorDetails::WorktreeUnavailable { task_id, reason },
                    "Task worktree is unavailable",
                )
            }
            Err(termloop_core::CoreError::RepairInProgress {
                task_id,
                operation_id,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::RepairInProgress {
                    task_id,
                    operation_id,
                },
                "worktree repair is already in progress",
            ),
            Err(termloop_core::CoreError::WorktreeRepairRefused {
                task_id,
                expected_managed_worktree_operation_id,
                expected_worktree_generation,
                blockers,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::WorktreeRepairRefused {
                    task_id,
                    expected_managed_worktree_operation_id,
                    expected_worktree_generation,
                    blockers: blockers
                        .into_iter()
                        .map(|blocker| {
                            serde_json::from_value(json!(
                                termloop_core::task_worktree::repair_blocker_name(&blocker)
                            ))
                            .expect("repair blocker matches contract")
                        })
                        .collect(),
                },
                "worktree repair was refused",
            ),
            Err(termloop_core::CoreError::WorktreeRepairRecoveryAttention {
                task_id,
                operation_id,
            }) => response_conflict(
                request.id,
                ProtocolErrorDetails::WorktreeRepairRecoveryAttention {
                    task_id,
                    operation_id,
                },
                "worktree repair needs recovery attention",
            ),
            Err(termloop_core::CoreError::WorktreePathConflict) => response_error(
                request.id,
                ErrorCode::Conflict,
                "worktree path conflicts with an existing path or registration",
            ),
            Err(termloop_core::CoreError::BranchMutationConflict) => response_error(
                request.id,
                ErrorCode::Conflict,
                "branch changed or became unavailable during provisioning",
            ),
            Err(termloop_core::CoreError::WorktreeLocked) => {
                response_error(request.id, ErrorCode::OperationFailed, "worktree is locked")
            }
            Err(
                error @ (termloop_core::CoreError::RepositoryUnavailable
                | termloop_core::CoreError::GitUnavailable
                | termloop_core::CoreError::GitUnsupportedVersion
                | termloop_core::CoreError::RepositoryPermissionDenied
                | termloop_core::CoreError::GitObservationTimedOut
                | termloop_core::CoreError::GitObservationOutputBound
                | termloop_core::CoreError::CorruptRepository
                | termloop_core::CoreError::UnsupportedRepository),
            ) => git_observation_error_response(request.id, error),
            Err(termloop_core::CoreError::ProjectDeleteBlocked(blocker)) => {
                let (message, blocker) = match blocker {
                    termloop_core::ProjectDeleteBlocker::Worktrees => (
                        "clean up the Project's Task worktrees first",
                        ProjectDeleteBlocker::Worktrees,
                    ),
                };
                response_conflict(
                    request.id,
                    ProtocolErrorDetails::ProjectDeleteBlocked { blocker },
                    message,
                )
            }
            Err(termloop_core::CoreError::AgentUnsupported) => response_error(
                request.id,
                ErrorCode::AgentUnsupported,
                "agent is not supported",
            ),
            Err(termloop_core::CoreError::AgentForkUnavailable { reason }) => {
                let reason = match reason {
                    termloop_core::AgentForkUnavailableReason::SourceNotRunning => {
                        protocol::AgentForkUnavailableReason::SourceNotRunning
                    }
                    termloop_core::AgentForkUnavailableReason::ResumeRefMissing => {
                        protocol::AgentForkUnavailableReason::ResumeRefMissing
                    }
                    termloop_core::AgentForkUnavailableReason::CapabilityUnavailable => {
                        protocol::AgentForkUnavailableReason::CapabilityUnavailable
                    }
                    termloop_core::AgentForkUnavailableReason::CwdUnavailable => {
                        protocol::AgentForkUnavailableReason::CwdUnavailable
                    }
                    termloop_core::AgentForkUnavailableReason::LaunchReserved => {
                        protocol::AgentForkUnavailableReason::LaunchReserved
                    }
                    termloop_core::AgentForkUnavailableReason::ProviderRejected => {
                        protocol::AgentForkUnavailableReason::ProviderRejected
                    }
                    termloop_core::AgentForkUnavailableReason::ProviderHistoryDamaged => {
                        protocol::AgentForkUnavailableReason::ProviderHistoryDamaged
                    }
                    termloop_core::AgentForkUnavailableReason::ConversationUnconfirmed => {
                        protocol::AgentForkUnavailableReason::ConversationUnconfirmed
                    }
                    termloop_core::AgentForkUnavailableReason::StartupExited => {
                        protocol::AgentForkUnavailableReason::StartupExited
                    }
                    termloop_core::AgentForkUnavailableReason::StartupTimedOut => {
                        protocol::AgentForkUnavailableReason::StartupTimedOut
                    }
                    termloop_core::AgentForkUnavailableReason::RuntimeConflict => {
                        protocol::AgentForkUnavailableReason::RuntimeConflict
                    }
                };
                response_conflict(
                    request.id,
                    ProtocolErrorDetails::AgentForkUnavailable { reason },
                    "agent conversation fork is unavailable",
                )
            }
            Err(termloop_core::CoreError::ProviderHistoryRepairUnavailable {
                session_id,
                reason,
            }) => {
                let reason = match reason {
                    termloop_core::ProviderHistoryRepairUnavailableReason::SessionRunning => {
                        protocol::ProviderHistoryRepairUnavailableReason::SessionRunning
                    }
                    termloop_core::ProviderHistoryRepairUnavailableReason::ProviderUnsupported => {
                        protocol::ProviderHistoryRepairUnavailableReason::ProviderUnsupported
                    }
                    termloop_core::ProviderHistoryRepairUnavailableReason::ResumeRefMissing => {
                        protocol::ProviderHistoryRepairUnavailableReason::ResumeRefMissing
                    }
                    termloop_core::ProviderHistoryRepairUnavailableReason::HistoryUnavailable => {
                        protocol::ProviderHistoryRepairUnavailableReason::HistoryUnavailable
                    }
                    termloop_core::ProviderHistoryRepairUnavailableReason::DamageUnrecognized => {
                        protocol::ProviderHistoryRepairUnavailableReason::DamageUnrecognized
                    }
                    termloop_core::ProviderHistoryRepairUnavailableReason::MutationFailed => {
                        protocol::ProviderHistoryRepairUnavailableReason::MutationFailed
                    }
                    termloop_core::ProviderHistoryRepairUnavailableReason::VerificationFailed => {
                        protocol::ProviderHistoryRepairUnavailableReason::VerificationFailed
                    }
                    termloop_core::ProviderHistoryRepairUnavailableReason::RecoveryAttention => {
                        protocol::ProviderHistoryRepairUnavailableReason::RecoveryAttention
                    }
                    termloop_core::ProviderHistoryRepairUnavailableReason::RuntimeConflict => {
                        protocol::ProviderHistoryRepairUnavailableReason::RuntimeConflict
                    }
                };
                response_conflict(
                    request.id,
                    ProtocolErrorDetails::ProviderHistoryRepairUnavailable { session_id, reason },
                    "provider history repair is unavailable",
                )
            }
            Err(termloop_core::CoreError::CapabilityDenied) => response_error(
                request.id,
                ErrorCode::CapabilityDenied,
                "credential does not allow this observation",
            ),
            Err(termloop_core::CoreError::CompanionTranscriptQuotaExceeded) => response_error(
                request.id,
                ErrorCode::QuotaExceeded,
                "Companion transcript quota exceeded; export and clear it before appending",
            ),
            Err(termloop_core::CoreError::AgentCapabilityUnproven) => response_error(
                request.id,
                ErrorCode::CapabilityUnproven,
                "selected assistant CLI is unavailable",
            ),
            Err(termloop_core::CoreError::TrackerRuntimeActive) => response_error(
                request.id,
                ErrorCode::Conflict,
                "disable and stop the Routine before deleting it",
            ),
            Err(
                error @ (termloop_core::CoreError::PlaybookStepRoutineHeld { .. }
                | termloop_core::CoreError::WorkerRuntimeActive
                | termloop_core::CoreError::WorkerHasRoutines { .. }),
            ) => response_error(request.id, ErrorCode::Conflict, &error.to_string()),
            Err(termloop_core::CoreError::TrackerReportStale) => response_error(
                request.id,
                ErrorCode::Conflict,
                "Routine check expired or changed generation",
            ),
            Err(termloop_core::CoreError::TrackerReportInvalid) => response_error(
                request.id,
                ErrorCode::InvalidMessage,
                "Routine report is invalid",
            ),
            Err(error) => {
                response_error(request.id, ErrorCode::OperationFailed, &error.to_string())
            }
        }
    };
    let subscription = if response.ok && requested_method == "control.subscribe" {
        response
            .result
            .as_ref()
            .and_then(|value| serde_json::from_value::<ControlSubscribeResult>(value.clone()).ok())
            .map(|value| value.topics)
    } else {
        None
    };
    DispatchOutcome {
        response: serde_json::to_string(&response).expect("control response is serializable"),
        subscription,
        project_demands: response.ok.then_some(requested_project_demands).flatten(),
        post_response: response.ok.then_some(post_response).flatten(),
    }
}
