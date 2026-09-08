use std::sync::atomic::Ordering;

use serde_json::{Value, json};
use termloop_contract::current as protocol;
use termloop_core::{
    CoreError, CoreRuntime, ProjectTaskAutomationConfiguration, TaskSourceImportPolicy,
};
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

use super::AppState;
use super::invalidation::{
    CommitImpact, InvalidationRequest, commit_invalidation, queue_invalidation,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TaskAutomationAction {
    task_id: String,
    project_id: String,
    title: String,
    create_worktree: bool,
    worktree_prefix: String,
    base_ref: Option<String>,
    agent_id: Option<String>,
    model: Option<String>,
    permission: Option<String>,
    reasoning: Option<String>,
    kickoff_message: Option<String>,
    workflow_id: Option<String>,
    workflow_goal: String,
}

pub(super) struct TaskAutomationSelection {
    pub(super) worktree_intent: protocol::TaskCreateWorktreeIntent,
    pub(super) worktree_prefix: Option<String>,
    pub(super) base_ref: Option<String>,
    pub(super) agent_id: Option<String>,
    pub(super) model: Option<String>,
    pub(super) permission: Option<String>,
    pub(super) reasoning: Option<String>,
    pub(super) kickoff_message: Option<String>,
    pub(super) workflow_id: Option<String>,
}

impl TaskAutomationSelection {
    pub(super) fn inherit() -> Self {
        Self {
            worktree_intent: protocol::TaskCreateWorktreeIntent::Inherit,
            worktree_prefix: None,
            base_ref: None,
            agent_id: None,
            model: None,
            permission: None,
            reasoning: None,
            kickoff_message: None,
            workflow_id: None,
        }
    }
}

/// Resolve and validate selection before the named Core write, under the same
/// Core lock. Binding the resulting Task must never read newer Project defaults.
#[derive(Clone)]
pub(super) struct PreparedTaskAutomation {
    project_id: String,
    settings: EffectiveTaskAutomation,
}

impl PreparedTaskAutomation {
    pub(super) fn prepare(
        core: &CoreRuntime,
        project_id: &str,
        selection: TaskAutomationSelection,
    ) -> Result<Self, CoreError> {
        let configuration = core.project_task_automation_configuration(project_id)?;
        Self::from_configuration(&configuration, selection)
    }

    fn from_configuration(
        configuration: &ProjectTaskAutomationConfiguration,
        selection: TaskAutomationSelection,
    ) -> Result<Self, CoreError> {
        Ok(Self {
            project_id: configuration.project_id.clone(),
            settings: effective_settings(configuration, selection)?,
        })
    }
}

/// Owns every already-committed effect, including a successful prefix of a
/// failed batch. The result is unavailable until publication and dispatch finish.
#[must_use = "Finish committed Task creation effects before returning the command result"]
pub(super) struct TaskCreationOutcome<T> {
    committed: CommittedTaskCreations,
    result: Result<T, CoreError>,
}

pub(super) struct CommittedTaskCreations {
    impact: CommitImpact,
    state_revision: Option<u64>,
    actions: Vec<TaskAutomationAction>,
}

impl CommittedTaskCreations {
    fn record_import(
        &mut self,
        imported: &termloop_core::TaskSourceImport,
        previous_revision: u64,
        automation: PreparedTaskAutomation,
    ) {
        self.record(
            &imported.task,
            imported.state_revision,
            (imported.state_revision != previous_revision).then_some(automation),
        );
    }

    pub(super) fn record(
        &mut self,
        task: &Value,
        state_revision: u64,
        automation: Option<PreparedTaskAutomation>,
    ) {
        self.state_revision = Some(state_revision);
        if let Some(automation) = automation {
            match action_from_task(&automation, task) {
                Ok(action) => self.actions.push(action),
                Err(error) => {
                    // The descriptor is already durable. A projection failure
                    // cannot hide its commit or invite a duplicate create retry.
                    tracing::error!(%error, "Committed Task automation could not be bound");
                }
            }
        }
    }
}

impl<T> TaskCreationOutcome<T> {
    pub(super) fn collect(
        impact: CommitImpact,
        command: impl FnOnce(&mut CommittedTaskCreations) -> Result<T, CoreError>,
    ) -> Self {
        let mut committed = CommittedTaskCreations {
            impact,
            state_revision: None,
            actions: Vec::new(),
        };
        let result = command(&mut committed);
        Self { committed, result }
    }

    /// Both the Core lock and any source refresh lock must be released first.
    pub(super) async fn finish(
        self,
        state: &AppState,
        observation_sequence: u64,
    ) -> Result<T, CoreError> {
        self.finish_with_dispatch(
            &state.invalidation_requests,
            observation_sequence,
            |actions| {
                let state = state.clone();
                tokio::spawn(async move { run(actions, &state).await });
            },
        )
        .await
    }

    async fn finish_with_dispatch(
        self,
        sender: &mpsc::Sender<InvalidationRequest>,
        observation_sequence: u64,
        dispatch: impl FnOnce(Vec<TaskAutomationAction>),
    ) -> Result<T, CoreError> {
        if let Some(revision) = self.committed.state_revision {
            queue_invalidation(
                sender,
                commit_invalidation(self.committed.impact, revision, observation_sequence),
            )
            .await;
        }
        if !self.committed.actions.is_empty() {
            dispatch(self.committed.actions);
        }
        self.result
    }
}

pub(super) async fn create_task(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskCreateParams>(params)
        .expect("validated Task create params");
    let outcome = {
        let mut core = state.core.lock().await;
        commit_created_task(&mut core, params)
    };
    outcome
        .finish(state, state.observation_sequence.load(Ordering::Relaxed))
        .await
}

fn commit_created_task(
    core: &mut CoreRuntime,
    params: protocol::TaskCreateParams,
) -> TaskCreationOutcome<Value> {
    TaskCreationOutcome::collect(CommitImpact::Task, |committed| {
        let selection = TaskAutomationSelection {
            worktree_intent: params.worktree_intent.clone(),
            worktree_prefix: params.worktree_prefix.clone(),
            base_ref: params.base_ref.clone(),
            agent_id: params.agent_id.clone(),
            model: params.model.clone(),
            permission: params.permission.clone(),
            reasoning: params.reasoning.clone(),
            kickoff_message: params.kickoff_message.clone(),
            workflow_id: params.workflow_id.clone(),
        };
        let automation = PreparedTaskAutomation::prepare(core, &params.project_id, selection)?;
        let task = core.handle(
            "task.create",
            serde_json::to_value(params).map_err(|error| CoreError::Store(error.to_string()))?,
        )?;
        committed.record(&task, core.state_revision(), Some(automation));
        Ok(task)
    })
}

pub(super) fn import_candidate(
    core: &mut CoreRuntime,
    params: protocol::TaskSourceCandidateImportParams,
) -> TaskCreationOutcome<Value> {
    TaskCreationOutcome::collect(CommitImpact::TaskSourceImport, |committed| {
        let source = core
            .task_source_view_by_id(&params.source_id)?
            .configuration;
        let automation = PreparedTaskAutomation::prepare(
            core,
            &source.project_id,
            TaskAutomationSelection {
                worktree_intent: params.worktree_intent,
                worktree_prefix: params.worktree_prefix,
                base_ref: params.base_ref,
                agent_id: params.agent_id,
                model: params.model,
                permission: params.permission,
                reasoning: params.reasoning,
                kickoff_message: params.kickoff_message,
                workflow_id: params.workflow_id,
            },
        )?;
        let before_revision = core.state_revision();
        let imported = core.import_task_source_candidate(
            &params.source_id,
            &params.external_id,
            params.expected_generation,
            params.expected_observation_sequence,
            params.expected_revision,
            termloop_platform::generate_uuid_v4(),
            super::current_epoch_ms(),
        )?;
        committed.record_import(&imported, before_revision, automation);
        Ok(json!({"task": imported.task, "stateRevision": imported.state_revision}))
    })
}

/// The caller holds the source refresh lock and Core lock. Complete the returned
/// outcome only after releasing both, even when a later candidate failed.
pub(super) fn auto_import_after_refresh(
    core: &mut CoreRuntime,
    source_id: &str,
    observation_sequence: u64,
) -> TaskCreationOutcome<()> {
    TaskCreationOutcome::collect(CommitImpact::TaskSourceImport, |committed| {
        let source = core.task_source_view_by_id(source_id)?.configuration;
        if source.import_policy != TaskSourceImportPolicy::AutoAdd || !source.enabled {
            return Ok(());
        }
        let active_task_count = core.active_task_source_task_count(source_id)?;
        let available_slots =
            available_auto_import_slots(source.auto_import_active_task_limit, active_task_count);
        if available_slots == 0 {
            return Ok(());
        }
        let automation = PreparedTaskAutomation::prepare(
            core,
            &source.project_id,
            TaskAutomationSelection::inherit(),
        )?;
        let candidates = core.task_source_candidates(source_id)?;
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
            committed.record_import(&imported, before_revision, automation.clone());
        }
        Ok(())
    })
}

fn available_auto_import_slots(limit: u64, active_task_count: u64) -> usize {
    // Domain validation caps the limit at 50, so this conversion is portable
    // even on platforms whose usize is narrower than u64.
    usize::try_from(limit.saturating_sub(active_task_count)).unwrap_or(0)
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
    automation: &PreparedTaskAutomation,
    task: &Value,
) -> Result<TaskAutomationAction, CoreError> {
    let task_id = task
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Store("created Task projection has no id".into()))?;
    let title = task
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Store("created Task projection has no title".into()))?;
    let (
        create_worktree,
        worktree_prefix,
        base_ref,
        agent_id,
        model,
        permission,
        reasoning,
        kickoff_message,
        workflow_id,
    ) = automation.settings.clone();
    Ok(TaskAutomationAction {
        task_id: task_id.to_owned(),
        project_id: automation.project_id.clone(),
        title: title.to_owned(),
        create_worktree,
        worktree_prefix,
        base_ref,
        agent_id,
        model,
        permission,
        reasoning,
        kickoff_message,
        workflow_id,
        workflow_goal: task
            .get("brief")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|brief| !brief.is_empty())
            .unwrap_or(title)
            .to_owned(),
    })
}

fn effective_settings(
    configuration: &ProjectTaskAutomationConfiguration,
    selection: TaskAutomationSelection,
) -> Result<EffectiveTaskAutomation, CoreError> {
    let TaskAutomationSelection {
        worktree_intent,
        worktree_prefix,
        base_ref,
        agent_id,
        model,
        permission,
        reasoning,
        kickoff_message,
        workflow_id,
    } = selection;
    match (
        worktree_intent,
        worktree_prefix,
        base_ref,
        agent_id,
        model,
        permission,
        reasoning,
        kickoff_message,
        workflow_id,
    ) {
        (
            protocol::TaskCreateWorktreeIntent::Inherit,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        ) => Ok((
            configuration.create_worktree,
            configuration.worktree_prefix.clone(),
            configuration.base_ref.clone(),
            configuration.agent_id.clone(),
            configuration.model.clone(),
            configuration.permission.clone(),
            configuration.reasoning.clone(),
            configuration.kickoff_message.clone(),
            configuration.workflow_id.clone(),
        )),
        (
            protocol::TaskCreateWorktreeIntent::None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        ) => Ok((
            false,
            configuration.worktree_prefix.clone(),
            configuration.base_ref.clone(),
            None,
            None,
            None,
            None,
            None,
            None,
        )),
        (
            protocol::TaskCreateWorktreeIntent::Provision,
            Some(worktree_prefix),
            Some(base_ref),
            agent_id,
            model,
            permission,
            reasoning,
            kickoff_message,
            workflow_id,
        ) => {
            let selection = ProjectTaskAutomationConfiguration {
                project_id: configuration.project_id.clone(),
                create_worktree: true,
                worktree_prefix: worktree_prefix.trim().to_owned(),
                base_ref: Some(base_ref.trim().to_owned()),
                agent_id: agent_id.map(|value| value.trim().to_owned()),
                model: model.map(|value| value.trim().to_owned()),
                permission: permission.map(|value| value.trim().to_owned()),
                reasoning: reasoning.map(|value| value.trim().to_owned()),
                kickoff_message: kickoff_message.map(|value| value.trim().to_owned()),
                workflow_id: workflow_id.map(|value| value.trim().to_owned()),
            };
            if !selection.is_valid() {
                return Err(CoreError::InvalidParams("taskAutomation".into()));
            }
            Ok((
                true,
                selection.worktree_prefix,
                selection.base_ref,
                selection.agent_id,
                selection.model,
                selection.permission,
                selection.reasoning,
                selection.kickoff_message,
                selection.workflow_id,
            ))
        }
        _ => Err(CoreError::InvalidParams("taskAutomation".into())),
    }
}

type EffectiveTaskAutomation = (
    // Keep the workflow reference separate from the ordinary Agent launch
    // settings; domain validation prevents both from being selected together.
    bool,
    String,
    Option<String>,
    Option<String>,
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
    if let Some(workflow_id) = &action.workflow_id {
        super::control::launch_automated_task_workflow(
            json!({
                "taskId": action.task_id,
                "workflowId": workflow_id,
                "goal": action.workflow_goal,
            }),
            state,
        )
        .await?;
    } else if let Some(agent_id) = &action.agent_id {
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
        params["baseRef"] = json!(select_base_ref(&branches, action.base_ref.as_deref())?);
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
        .lock()
        .unwrap()
        .clone()
        .iter()
        .find(|capability| capability.agent_id == agent_id && capability.available)
        .cloned()
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

fn select_base_ref(branches: &Value, configured: Option<&str>) -> Result<String, CoreError> {
    let observed = observed_base_refs(branches).collect::<Vec<_>>();
    if let Some(configured) = configured {
        return Ok(configured.to_owned());
    }
    ["development", "develop", "dev", "main", "master"]
        .into_iter()
        .filter_map(|preferred_name| {
            observed
                .iter()
                .find(|reference| {
                    reference
                        .strip_prefix("refs/remotes/origin/")
                        .is_some_and(|branch| branch == preferred_name)
                })
                .or_else(|| {
                    observed.iter().find(|reference| {
                        reference
                            .strip_prefix("refs/remotes/")
                            .and_then(|remote_branch| remote_branch.split_once('/'))
                            .is_some_and(|(_, branch)| branch == preferred_name)
                    })
                })
                .map(|reference| (*reference).to_owned())
        })
        .next()
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

fn observed_base_refs(projection: &Value) -> impl Iterator<Item = &str> {
    projection
        .get("base_branches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|branch| branch.get("exact_ref").and_then(Value::as_str))
}

#[cfg(test)]
mod creation_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_names_are_bounded_and_base_selection_prefers_integration_branches() {
        let branches = json!({
            "base_branches": [
                { "exact_ref": "refs/remotes/origin/main" },
                { "exact_ref": "refs/remotes/origin/development" }
            ]
        });
        assert_eq!(
            select_base_ref(&branches, None).unwrap(),
            "refs/remotes/origin/development"
        );
        assert_eq!(
            select_base_ref(
                &json!({ "base_branches": [{ "exact_ref": "refs/remotes/upstream/trunk" }] }),
                None,
            )
            .unwrap(),
            "refs/remotes/upstream/trunk"
        );
        assert_eq!(
            select_base_ref(&branches, Some("refs/remotes/origin/main")).unwrap(),
            "refs/remotes/origin/main"
        );
        assert_eq!(
            select_base_ref(&branches, Some("refs/remotes/origin/missing")).unwrap(),
            "refs/remotes/origin/missing"
        );
    }

    #[test]
    fn explicit_selection_wins_before_project_defaults() {
        let defaults = ProjectTaskAutomationConfiguration {
            project_id: "project-1".into(),
            create_worktree: true,
            worktree_prefix: "feature".into(),
            base_ref: Some("refs/remotes/origin/development".into()),
            agent_id: Some("codex".into()),
            workflow_id: None,
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
                    base_ref: None,
                    agent_id: None,
                    workflow_id: None,
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
                Some("refs/remotes/origin/development".into()),
                Some("codex".into()),
                Some("gpt-5.6-sol".into()),
                Some("bypassPermissions".into()),
                Some("high".into()),
                Some("Implement and verify.".into()),
                None,
            )
        );
        assert_eq!(
            effective_settings(
                &defaults,
                TaskAutomationSelection {
                    worktree_intent: protocol::TaskCreateWorktreeIntent::None,
                    worktree_prefix: None,
                    base_ref: None,
                    agent_id: None,
                    workflow_id: None,
                    model: None,
                    permission: None,
                    reasoning: None,
                    kickoff_message: None,
                },
            )
            .unwrap(),
            (
                false,
                "feature".into(),
                Some("refs/remotes/origin/development".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
        );
        assert_eq!(
            effective_settings(
                &defaults,
                TaskAutomationSelection {
                    worktree_intent: protocol::TaskCreateWorktreeIntent::Provision,
                    worktree_prefix: Some("custom".into()),
                    base_ref: Some("refs/remotes/upstream/main".into()),
                    agent_id: Some("claude".into()),
                    workflow_id: None,
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
                Some("refs/remotes/upstream/main".into()),
                Some("claude".into()),
                Some("sonnet".into()),
                Some("plan".into()),
                Some("medium".into()),
                Some("Start with the regression test.".into()),
                None,
            )
        );
    }

    #[test]
    fn workflow_automation_inherits_overrides_or_declines_without_an_extra_agent() {
        let defaults = ProjectTaskAutomationConfiguration {
            project_id: "project-1".into(),
            create_worktree: true,
            worktree_prefix: "feature".into(),
            base_ref: Some("refs/remotes/origin/develop".into()),
            workflow_id: Some("workflow-1".into()),
            agent_id: None,
            model: None,
            permission: None,
            reasoning: None,
            kickoff_message: None,
        };
        let selection = || TaskAutomationSelection {
            worktree_intent: protocol::TaskCreateWorktreeIntent::Inherit,
            worktree_prefix: None,
            base_ref: None,
            workflow_id: None,
            agent_id: None,
            model: None,
            permission: None,
            reasoning: None,
            kickoff_message: None,
        };
        for brief in [
            json!("  Build the new screen.\n "),
            json!(null),
            json!("  "),
        ] {
            let task = json!({"id": "task-1", "title": "New screen", "brief": brief});
            let action = action_from_task(
                &PreparedTaskAutomation::from_configuration(&defaults, selection()).unwrap(),
                &task,
            )
            .unwrap();
            assert_eq!(action.workflow_id.as_deref(), Some("workflow-1"));
            assert!(action.agent_id.is_none());
            assert!(action.create_worktree);
            assert_eq!(
                action.workflow_goal,
                if brief == json!("  Build the new screen.\n ") {
                    "Build the new screen."
                } else {
                    "New screen"
                }
            );

            let mut explicit = selection();
            explicit.worktree_intent = protocol::TaskCreateWorktreeIntent::Provision;
            explicit.worktree_prefix = Some("custom".into());
            explicit.base_ref = Some("refs/remotes/upstream/main".into());
            explicit.workflow_id = Some("workflow-2".into());
            let action = action_from_task(
                &PreparedTaskAutomation::from_configuration(&defaults, explicit).unwrap(),
                &task,
            )
            .unwrap();
            assert_eq!(action.workflow_id.as_deref(), Some("workflow-2"));
            assert_eq!(action.worktree_prefix, "custom");
            assert!(action.agent_id.is_none());

            let mut declined = selection();
            declined.worktree_intent = protocol::TaskCreateWorktreeIntent::None;
            let action = action_from_task(
                &PreparedTaskAutomation::from_configuration(&defaults, declined).unwrap(),
                &task,
            )
            .unwrap();
            assert!(!action.create_worktree);
            assert!(action.workflow_id.is_none());
        }
        let mut mixed = selection();
        mixed.worktree_intent = protocol::TaskCreateWorktreeIntent::Provision;
        mixed.worktree_prefix = Some("feature".into());
        mixed.base_ref = Some("refs/remotes/origin/develop".into());
        mixed.workflow_id = Some("workflow-1".into());
        mixed.agent_id = Some("codex".into());
        mixed.model = Some("default".into());
        mixed.permission = Some("default".into());
        mixed.reasoning = Some("default".into());
        assert!(matches!(
            effective_settings(&defaults, mixed),
            Err(CoreError::InvalidParams(_))
        ));
    }

    #[test]
    fn auto_import_slots_stop_at_the_source_active_task_limit() {
        assert_eq!(available_auto_import_slots(5, 0), 5);
        assert_eq!(available_auto_import_slots(5, 3), 2);
        assert_eq!(available_auto_import_slots(5, 5), 0);
        assert_eq!(available_auto_import_slots(5, 8), 0);
    }
}
