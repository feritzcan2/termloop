use serde_json::{Value, json};
use termloop_contract::current::{self as protocol, ProjectionTopic};
use termloop_core::{CoreError, ProjectTaskAutomationConfiguration, TaskSourceImportPolicy};
use tokio::time::{Duration, Instant};

use super::AppState;
use super::invalidation::InvalidationRequest;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TaskAutomationAction {
    task_id: String,
    project_id: String,
    title: String,
    create_worktree: bool,
    worktree_prefix: String,
    agent_id: Option<String>,
    model: Option<String>,
    permission: Option<String>,
    reasoning: Option<String>,
    kickoff_message: Option<String>,
}

pub(super) struct TaskAutomationSelection {
    pub(super) worktree_intent: protocol::TaskCreateWorktreeIntent,
    pub(super) worktree_prefix: Option<String>,
    pub(super) agent_id: Option<String>,
    pub(super) model: Option<String>,
    pub(super) permission: Option<String>,
    pub(super) reasoning: Option<String>,
    pub(super) kickoff_message: Option<String>,
}

pub(super) async fn create_task(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskCreateParams>(params)
        .expect("validated Task create params");
    let selection = TaskAutomationSelection {
        worktree_intent: params.worktree_intent.clone(),
        worktree_prefix: params.worktree_prefix.clone(),
        agent_id: params.agent_id.clone(),
        model: params.model.clone(),
        permission: params.permission.clone(),
        reasoning: params.reasoning.clone(),
        kickoff_message: params.kickoff_message.clone(),
    };
    let project_id = params.project_id.clone();
    let (task, action, state_revision) = {
        let mut core = state.core.lock().await;
        let task = core.handle(
            "task.create",
            serde_json::to_value(params).map_err(|error| CoreError::Store(error.to_string()))?,
        )?;
        let configuration = core.project_task_automation_configuration(&project_id)?;
        let action = action_from_task(&configuration, &task, selection)?;
        (task, action, core.state_revision())
    };
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Task],
        state_revision,
        observation_sequence: state
            .observation_sequence
            .load(std::sync::atomic::Ordering::Relaxed),
    });
    spawn(vec![action], state);
    Ok(task)
}

/// Imports only as many still-new candidates as the source's active-Task WIP
/// limit permits. The source refresh lock is held by the caller, so a manual
/// import cannot race this snapshot. Each candidate still passes Core's
/// stable-ID and revision gates; a retry therefore returns the already-linked
/// Task instead of making a duplicate.
pub(super) async fn auto_import_after_refresh(
    source_id: &str,
    observation_sequence: u64,
    state: &AppState,
) -> Result<Vec<TaskAutomationAction>, CoreError> {
    let (actions, state_revision) = {
        let mut core = state.core.lock().await;
        let source = core.task_source_view_by_id(source_id)?.configuration;
        if source.import_policy != TaskSourceImportPolicy::AutoAdd || !source.enabled {
            return Ok(Vec::new());
        }
        let active_task_count = core.active_task_source_task_count(source_id)?;
        let available_slots =
            available_auto_import_slots(source.auto_import_active_task_limit, active_task_count);
        if available_slots == 0 {
            return Ok(Vec::new());
        }
        let configuration = core.project_task_automation_configuration(&source.project_id)?;
        let candidates = core.task_source_candidates(source_id)?;
        let mut actions = Vec::new();
        for candidate in candidates
            .into_iter()
            .filter(|candidate| {
                candidate.state == "new" && candidate.observation_sequence == observation_sequence
            })
            .take(available_slots)
        {
            let before_revision = core.state_revision();
            let imported = core.import_task_source_candidate(
                source_id,
                &candidate.candidate.external_id,
                candidate.observed_generation,
                candidate.observation_sequence,
                before_revision,
                termloop_platform::generate_uuid_v4(),
                super::current_epoch_ms(),
            )?;
            if imported.state_revision != before_revision {
                actions.push(action_from_task(
                    &configuration,
                    &imported.task,
                    TaskAutomationSelection {
                        worktree_intent: protocol::TaskCreateWorktreeIntent::Inherit,
                        worktree_prefix: None,
                        agent_id: None,
                        model: None,
                        permission: None,
                        reasoning: None,
                        kickoff_message: None,
                    },
                )?);
            }
        }
        (actions, core.state_revision())
    };
    if !actions.is_empty() {
        publish_import(state, state_revision, observation_sequence);
    }
    Ok(actions)
}

fn available_auto_import_slots(limit: u64, active_task_count: u64) -> usize {
    // Domain validation caps the limit at 50, so this conversion is portable
    // even on platforms whose usize is narrower than u64.
    usize::try_from(limit.saturating_sub(active_task_count)).unwrap_or(0)
}

pub(super) async fn action_for_task(
    task: &Value,
    selection: TaskAutomationSelection,
    state: &AppState,
) -> Result<TaskAutomationAction, CoreError> {
    let project_id = task
        .get("project_id")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Store("created Task projection has no project_id".into()))?;
    let configuration = state
        .core
        .lock()
        .await
        .project_task_automation_configuration(project_id)?;
    action_from_task(&configuration, task, selection)
}

pub(super) fn spawn(actions: Vec<TaskAutomationAction>, state: &AppState) {
    if actions.is_empty() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move { run(actions, &state).await });
}

async fn run(actions: Vec<TaskAutomationAction>, state: &AppState) {
    for action in actions {
        if let Err(error) = run_one(&action, state).await {
            tracing::warn!(
                task_id = %action.task_id,
                %error,
                "Task post-create automation did not complete"
            );
        }
    }
}

fn action_from_task(
    configuration: &ProjectTaskAutomationConfiguration,
    task: &Value,
    selection: TaskAutomationSelection,
) -> Result<TaskAutomationAction, CoreError> {
    let task_id = task
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Store("created Task projection has no id".into()))?;
    let title = task
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Store("created Task projection has no title".into()))?;
    let (create_worktree, worktree_prefix, agent_id, model, permission, reasoning, kickoff_message) =
        effective_settings(configuration, selection)?;
    Ok(TaskAutomationAction {
        task_id: task_id.to_owned(),
        project_id: configuration.project_id.clone(),
        title: title.to_owned(),
        create_worktree,
        worktree_prefix,
        agent_id,
        model,
        permission,
        reasoning,
        kickoff_message,
    })
}

fn effective_settings(
    configuration: &ProjectTaskAutomationConfiguration,
    selection: TaskAutomationSelection,
) -> Result<EffectiveTaskAutomation, CoreError> {
    let TaskAutomationSelection {
        worktree_intent,
        worktree_prefix,
        agent_id,
        model,
        permission,
        reasoning,
        kickoff_message,
    } = selection;
    match (
        worktree_intent,
        worktree_prefix,
        agent_id,
        model,
        permission,
        reasoning,
        kickoff_message,
    ) {
        (protocol::TaskCreateWorktreeIntent::Inherit, None, None, None, None, None, None) => Ok((
            configuration.create_worktree,
            configuration.worktree_prefix.clone(),
            configuration.agent_id.clone(),
            configuration.model.clone(),
            configuration.permission.clone(),
            configuration.reasoning.clone(),
            configuration.kickoff_message.clone(),
        )),
        (protocol::TaskCreateWorktreeIntent::None, None, None, None, None, None, None) => Ok((
            false,
            configuration.worktree_prefix.clone(),
            None,
            None,
            None,
            None,
            None,
        )),
        (
            protocol::TaskCreateWorktreeIntent::Provision,
            Some(worktree_prefix),
            agent_id,
            model,
            permission,
            reasoning,
            kickoff_message,
        ) => {
            let selection = ProjectTaskAutomationConfiguration {
                project_id: configuration.project_id.clone(),
                create_worktree: true,
                worktree_prefix: worktree_prefix.trim().to_owned(),
                agent_id: agent_id.map(|value| value.trim().to_owned()),
                model: model.map(|value| value.trim().to_owned()),
                permission: permission.map(|value| value.trim().to_owned()),
                reasoning: reasoning.map(|value| value.trim().to_owned()),
                kickoff_message: kickoff_message.map(|value| value.trim().to_owned()),
            };
            if !selection.is_valid() {
                return Err(CoreError::InvalidParams("taskAutomation".into()));
            }
            Ok((
                true,
                selection.worktree_prefix,
                selection.agent_id,
                selection.model,
                selection.permission,
                selection.reasoning,
                selection.kickoff_message,
            ))
        }
        _ => Err(CoreError::InvalidParams("taskAutomation".into())),
    }
}

type EffectiveTaskAutomation = (
    bool,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

async fn run_one(action: &TaskAutomationAction, state: &AppState) -> Result<(), CoreError> {
    if !action.create_worktree {
        return Ok(());
    }
    provision_worktree(action, state).await?;
    if let Some(agent_id) = &action.agent_id {
        launch_agent(action, agent_id, state).await?;
    }
    Ok(())
}

async fn provision_worktree(
    action: &TaskAutomationAction,
    state: &AppState,
) -> Result<(), CoreError> {
    let branches = super::control::project_list_local_branches(
        json!({ "projectId": action.project_id }),
        state,
    )
    .await?;
    let repository_path = branches
        .get("repository_root")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::InvalidParams("projectId".into()))?;
    let checkout_names = termloop_core::managed_task_checkout_names(
        &action.title,
        &action.task_id,
        &action.worktree_prefix,
    );
    let branch_name = checkout_names.branch_name;
    let destination =
        termloop_platform::sibling_directory_path(repository_path, &checkout_names.worktree_leaf)
            .map_err(|_| CoreError::InvalidParams("projectId".into()))?;
    let destination = destination
        .to_str()
        .ok_or_else(|| CoreError::InvalidParams("projectId".into()))?;
    let existing_ref = format!("refs/heads/{branch_name}");
    let branch_exists = observed_branch_refs(&branches).any(|candidate| candidate == existing_ref);
    let mut params = json!({
        // Task IDs are UUIDs. Reusing the Task ID makes a daemon retry of this
        // exact post-create action idempotent in the provisioning saga.
        "operationId": action.task_id,
        "taskId": action.task_id,
        "repositoryPath": repository_path,
        "destinationPath": destination,
        "branchName": branch_name,
        "branchMode": if branch_exists { "existing" } else { "create" },
    });
    if !branch_exists {
        params["baseRef"] = json!(select_base_ref(&branches)?);
    }
    super::control::provision_task_worktree(params, state).await?;
    Ok(())
}

async fn launch_agent(
    action: &TaskAutomationAction,
    agent_id: &str,
    state: &AppState,
) -> Result<(), CoreError> {
    let capability = state
        .agent_capabilities
        .iter()
        .find(|capability| capability.agent_id == agent_id && capability.available)
        .ok_or(CoreError::AgentUnsupported)?;
    let model = action
        .model
        .as_deref()
        .ok_or_else(|| CoreError::InvalidParams("model".into()))?;
    if !capability.models.iter().any(|candidate| candidate == model) {
        return Err(CoreError::InvalidParams("model".into()));
    }
    let permission = action
        .permission
        .as_deref()
        .ok_or_else(|| CoreError::InvalidParams("permission".into()))?;
    if !capability
        .permissions
        .iter()
        .any(|candidate| candidate == permission)
    {
        return Err(CoreError::InvalidParams("permission".into()));
    }
    let reasoning = action
        .reasoning
        .as_deref()
        .ok_or_else(|| CoreError::InvalidParams("reasoning".into()))?;
    if !capability
        .reasoning
        .iter()
        .any(|candidate| candidate == reasoning)
    {
        return Err(CoreError::InvalidParams("reasoning".into()));
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut preview_params = json!({
        "taskId": action.task_id,
        "agentId": agent_id,
        "model": model,
        "permission": permission,
        "reasoning": reasoning,
    });
    if let Some(kickoff_message) = &action.kickoff_message {
        preview_params["kickoffMessage"] = json!(kickoff_message);
    }
    let preview =
        super::control::preview_task_agent_session(preview_params, deadline, state).await?;
    let launch_ticket = preview
        .get("launch_ticket")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Store("Task Agent preview returned no launch ticket".into()))?;
    super::control::launch_task_session(
        json!({
            "taskId": action.task_id,
            "agentId": agent_id,
            "model": model,
            "permission": permission,
            "reasoning": reasoning,
            "launchTicket": launch_ticket,
        }),
        true,
        Instant::now() + Duration::from_secs(15),
        state,
    )
    .await?;
    Ok(())
}

fn select_base_ref(branches: &Value) -> Result<String, CoreError> {
    let observed = observed_branch_refs(branches).collect::<Vec<_>>();
    ["development", "develop", "dev", "main", "master"]
        .into_iter()
        .map(|name| format!("refs/heads/{name}"))
        .find(|candidate| observed.iter().any(|observed| observed == candidate))
        .or_else(|| observed.first().map(|reference| (*reference).to_owned()))
        .ok_or_else(|| CoreError::InvalidParams("baseRef".into()))
}

fn observed_branch_refs(projection: &Value) -> impl Iterator<Item = &str> {
    projection
        .get("branches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|branch| branch.get("exact_ref").and_then(Value::as_str))
}

fn publish_import(state: &AppState, state_revision: u64, observation_sequence: u64) {
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::TaskSource, ProjectionTopic::Task],
        state_revision,
        observation_sequence,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_names_are_bounded_and_base_selection_prefers_integration_branches() {
        let branches = json!({
            "branches": [
                { "exact_ref": "refs/heads/main" },
                { "exact_ref": "refs/heads/development" }
            ]
        });
        assert_eq!(
            select_base_ref(&branches).unwrap(),
            "refs/heads/development"
        );
        assert_eq!(
            select_base_ref(&json!({ "branches": [{ "exact_ref": "refs/heads/trunk" }] })).unwrap(),
            "refs/heads/trunk"
        );
    }

    #[test]
    fn explicit_selection_wins_before_project_defaults() {
        let defaults = ProjectTaskAutomationConfiguration {
            project_id: "project-1".into(),
            create_worktree: true,
            worktree_prefix: "feature".into(),
            agent_id: Some("codex".into()),
            model: Some("gpt-5.6-sol".into()),
            permission: Some("bypassPermissions".into()),
            reasoning: Some("high".into()),
            kickoff_message: Some("Implement and verify.".into()),
        };
        assert_eq!(
            effective_settings(
                &defaults,
                TaskAutomationSelection {
                    worktree_intent: protocol::TaskCreateWorktreeIntent::Inherit,
                    worktree_prefix: None,
                    agent_id: None,
                    model: None,
                    permission: None,
                    reasoning: None,
                    kickoff_message: None,
                },
            )
            .unwrap(),
            (
                true,
                "feature".into(),
                Some("codex".into()),
                Some("gpt-5.6-sol".into()),
                Some("bypassPermissions".into()),
                Some("high".into()),
                Some("Implement and verify.".into()),
            )
        );
        assert_eq!(
            effective_settings(
                &defaults,
                TaskAutomationSelection {
                    worktree_intent: protocol::TaskCreateWorktreeIntent::None,
                    worktree_prefix: None,
                    agent_id: None,
                    model: None,
                    permission: None,
                    reasoning: None,
                    kickoff_message: None,
                },
            )
            .unwrap(),
            (false, "feature".into(), None, None, None, None, None)
        );
        assert_eq!(
            effective_settings(
                &defaults,
                TaskAutomationSelection {
                    worktree_intent: protocol::TaskCreateWorktreeIntent::Provision,
                    worktree_prefix: Some("custom".into()),
                    agent_id: Some("claude".into()),
                    model: Some("sonnet".into()),
                    permission: Some("plan".into()),
                    reasoning: Some("medium".into()),
                    kickoff_message: Some("Start with the regression test.".into()),
                },
            )
            .unwrap(),
            (
                true,
                "custom".into(),
                Some("claude".into()),
                Some("sonnet".into()),
                Some("plan".into()),
                Some("medium".into()),
                Some("Start with the regression test.".into()),
            )
        );
    }

    #[test]
    fn auto_import_slots_stop_at_the_source_active_task_limit() {
        assert_eq!(available_auto_import_slots(5, 0), 5);
        assert_eq!(available_auto_import_slots(5, 3), 2);
        assert_eq!(available_auto_import_slots(5, 5), 0);
        assert_eq!(available_auto_import_slots(5, 8), 0);
    }
}
