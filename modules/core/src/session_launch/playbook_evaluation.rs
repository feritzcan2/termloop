use serde_json::{Value, json};

use super::{AgentLaunchPlan, AgentMcpRole, TaskLaunchGuard};
use crate::companion_integrations::tracker_runtime::StewardRoutineClaim;
use crate::{CoreError, CoreRuntime, required_string, store_error};
use termloop_domain::{PlaybookEvaluationOutcome as Outcome, PlaybookEvaluationRecord};

pub enum PlaybookEvaluationLaunch {
    Fork {
        plan: Box<AgentLaunchPlan>,
        check_id: String,
        result: Value,
    },
    /// A fresh evaluator in the Task's checkout, for a Task without an Agent
    /// that can be forked.
    Fresh {
        plan: Box<AgentLaunchPlan>,
        check_id: String,
        result: Value,
    },
    Delegated(Value),
    Skipped(Value),
    Steward(Value),
}

impl CoreRuntime {
    pub fn plan_playbook_evaluation(
        &mut self,
        claim: &StewardRoutineClaim,
    ) -> Result<PlaybookEvaluationLaunch, CoreError> {
        let Some(capability) = claim.capability.as_ref() else {
            return Ok(PlaybookEvaluationLaunch::Steward(claim.result.clone()));
        };
        let Some(task_id) = self.tracker_check_task_id(capability)? else {
            return Ok(PlaybookEvaluationLaunch::Steward(claim.result.clone()));
        };
        let now = termloop_platform::current_epoch_ms();
        self.validate_current_check(capability, now)?;
        if let Some(evaluation) = self
            .playbook_evaluation
            .evaluations
            .get(&capability.check_id)
        {
            self.validate_playbook_evaluation(evaluation, now)?;
            return Ok(PlaybookEvaluationLaunch::Delegated(delegated_result(
                &capability.check_id,
                evaluation.source_session_id.as_deref(),
                &evaluation.session_id,
            )));
        }
        self.playbook_evaluation
            .waiting
            .remove(&(capability.tracker_id.clone(), task_id.clone()));
        // Evaluate through a fork of the Agent that did the work: it knows
        // where the evidence is. A Task with no such Agent waits for one
        // rather than getting an evaluator that never saw the work. A fresh
        // evaluator only stands in when that Agent exists but cannot fork.
        let Some(source) = self.select_playbook_source(&capability.project_id, &task_id, now)?
        else {
            return Ok(PlaybookEvaluationLaunch::Skipped(
                self.defer_playbook_evaluation(claim, "noUnambiguousTaskAgent")?,
            ));
        };
        let (mut plan, source) = match self.plan_evaluation_fork(&source) {
            Ok(plan) => (plan, Some(source)),
            Err(reason) => {
                match self.plan_fresh_playbook_evaluator(&capability.project_id, &task_id)? {
                    Some(plan) => (plan, None),
                    None => {
                        return Ok(PlaybookEvaluationLaunch::Skipped(
                            self.defer_playbook_evaluation(claim, reason)?,
                        ));
                    }
                }
            }
        };
        plan.mcp_role = AgentMcpRole::PlaybookEvaluator {
            check_id: capability.check_id.clone(),
        };
        let settings = self
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == capability.project_id)
            .map(|configuration| configuration.playbook_evaluator.clone())
            .unwrap_or_default();
        let model = match plan.agent_id.as_str() {
            "codex" => settings.codex_model,
            "claude" => settings.claude_model,
            _ => None,
        };
        let selection = plan.interactive_options.get_or_insert_default();
        if let Some(model) = model {
            selection.model = model;
        }
        selection.permission = settings.permission;
        // The generated Session name; a fresh evaluator is not a fork.
        plan.fork_name = Some("Playbook evaluation".into());
        match self.reserve_playbook_evaluation(
            claim,
            source.clone(),
            plan.session_id.clone(),
            plan.runtime_epoch,
        ) {
            Ok(()) => {}
            Err(CoreError::HelperCapacityExhausted) => {
                return Ok(PlaybookEvaluationLaunch::Skipped(
                    self.defer_playbook_evaluation(claim, "evaluationCapacity")?,
                ));
            }
            Err(error) => return Err(error),
        }
        if let Err(error) = self.record_playbook_evaluation_start(&plan, &capability.check_id) {
            self.playbook_evaluation
                .evaluations
                .remove(&capability.check_id);
            return Err(error);
        }
        let result = delegated_result(&capability.check_id, source.as_deref(), &plan.session_id);
        let check_id = capability.check_id.clone();
        Ok(match source {
            Some(_) => PlaybookEvaluationLaunch::Fork {
                result,
                check_id,
                plan: Box::new(plan),
            },
            None => PlaybookEvaluationLaunch::Fresh {
                result,
                check_id,
                plan: Box::new(plan),
            },
        })
    }

    fn plan_evaluation_fork(&self, source: &str) -> Result<AgentLaunchPlan, &'static str> {
        let provider = self
            .store
            .sessions()
            .iter()
            .find(|s| s.id == source)
            .and_then(|s| s.process.agent_id.as_deref());
        if !provider.is_some_and(|id| {
            self.observation_transport
                .as_ref()
                .is_some_and(|t| t.native_fork_supported(id))
        }) {
            return Err("forkUnsupported");
        }
        match self.plan_agent_fork(json!({"sessionId": source})) {
            Ok(plan) if plan.mcp_token.is_some() => Ok(plan),
            _ => Err("forkUnavailable"),
        }
    }

    /// Plans a fresh evaluator with the last ordinary Agent provider and
    /// launch selection, in the Task's managed worktree or else the Project
    /// checkout. `None` when no provider is known or it cannot carry the
    /// evaluator's MCP tools.
    fn plan_fresh_playbook_evaluator(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<Option<AgentLaunchPlan>, CoreError> {
        let Some(saved) = self.store.last_agent_launch_selection().cloned() else {
            return Ok(None);
        };
        if termloop_agents::executable_for(&saved.agent_id).is_none()
            || !self
                .observation_transport
                .as_ref()
                .is_some_and(|transport| transport.mcp_http_supported(&saved.agent_id))
        {
            return Ok(None);
        }
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id && task.project_id == project_id)
            .ok_or(CoreError::NotFound)?;
        let guard = task.worktree.as_ref().and_then(|binding| {
            self.store
                .managed_worktrees()
                .iter()
                .find(|proof| {
                    proof.task_id == task.id
                        && proof.worktree_generation == task.worktree_generation
                })
                .map(|proof| TaskLaunchGuard {
                    task_id: task.id.clone(),
                    managed_worktree_operation_id: proof.operation_id.clone(),
                    worktree_generation: proof.worktree_generation,
                    cwd: binding.path.clone(),
                    repository_common_dir: proof.repository_common_dir.clone(),
                    branch_ref: proof.branch_ref.clone(),
                })
        });
        let cwd = match &guard {
            Some(guard) => guard.cwd.clone(),
            None => self
                .store
                .projects()
                .iter()
                .find(|project| project.id == project_id)
                .ok_or(CoreError::NotFound)?
                .folder_path
                .clone(),
        };
        if self
            .ensure_launch_not_reserved(std::path::Path::new(&cwd))
            .is_err()
        {
            return Ok(None);
        }
        let mut plan = match self.plan_agent_launch_at(
            project_id.to_owned(),
            cwd,
            saved.agent_id.clone(),
            uuid::Uuid::new_v4().to_string(),
            AgentMcpRole::Interactive,
        ) {
            Ok(plan) if plan.mcp_token.is_some() => plan,
            _ => return Ok(None),
        };
        plan.set_account(
            self.resolve_agent_account(&saved.agent_id, saved.selection.account_id.as_deref())?,
        );
        plan.interactive_options = Some(saved.selection);
        plan.task_guard_requires_observation = guard.is_some();
        plan.task_guard = guard;
        Ok(Some(plan))
    }

    fn record_playbook_evaluation_start(
        &mut self,
        plan: &AgentLaunchPlan,
        check_id: &str,
    ) -> Result<(), CoreError> {
        let evaluation = self
            .playbook_evaluation
            .evaluations
            .get(check_id)
            .ok_or(CoreError::TrackerReportStale)?;
        let source = match &evaluation.source_session_id {
            Some(id) => Some(
                self.store
                    .sessions()
                    .iter()
                    .find(|s| &s.id == id)
                    .ok_or(CoreError::NotFound)?,
            ),
            None => None,
        };
        let task = self
            .store
            .tasks()
            .iter()
            .find(|t| t.id == evaluation.task_id)
            .ok_or(CoreError::NotFound)?;
        let selection = plan.interactive_options.clone().unwrap_or_default();
        let step = &evaluation.assignment["step"];
        let record = PlaybookEvaluationRecord {
            id: check_id.to_owned(),
            project_id: evaluation.capability.project_id.clone(),
            task_id: task.id.clone(),
            task_title: task.title.clone(),
            milestone_id: required_string(step, "milestoneId")?,
            milestone_title: required_string(step, "title")?,
            source_session_id: source.map(|source| source.id.clone()),
            source_name: source
                .map(|source| source.name.clone().unwrap_or_else(|| plan.agent_id.clone())),
            session_id: plan.session_id.clone(),
            agent_id: plan.agent_id.clone(),
            model: selection.model,
            permission: selection.permission,
            started_at_epoch_ms: evaluation.capability.claimed_at_epoch_ms,
            finished_at_epoch_ms: None,
            outcome: Outcome::InProgress,
            evidence: String::new(),
        };
        self.store
            .start_playbook_evaluation(&self.write_authority, record)
            .map_err(store_error)
    }

    pub(super) fn revalidate_playbook_evaluator_launch(
        &self,
        plan: &AgentLaunchPlan,
    ) -> Result<(), CoreError> {
        if let AgentMcpRole::PlaybookEvaluator { check_id } = &plan.mcp_role {
            let evaluation = self
                .playbook_evaluation
                .evaluations
                .get(check_id)
                .filter(|e| {
                    e.session_id == plan.session_id && e.runtime_epoch == plan.runtime_epoch
                })
                .ok_or(CoreError::TrackerReportStale)?;
            self.validate_playbook_evaluation(evaluation, termloop_platform::current_epoch_ms())?;
        }
        Ok(())
    }
}

fn delegated_result(check_id: &str, source: Option<&str>, evaluator: &str) -> Value {
    json!({"status": "delegated", "checkId": check_id, "evaluation": {
        "sourceSessionId": source, "sessionId": evaluator,
        "selection": if source.is_some() { "observedTaskWorkOrCanonicalAgent" } else { "freshEvaluator" },
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_integrations::playbook_runtime::tests::pipeline_runtime;
    use crate::runtime::playbook_evaluation::tests::attach_agents;
    #[test]
    fn evaluator_settings_override_only_the_fork_and_defaults_inherit_the_source_model() {
        for model in [None, Some("gpt-6-luna"), Some("default")] {
            for permission in ["plan", "default", "acceptEdits", "bypassPermissions"] {
                let (mut runtime, root, project) = pipeline_runtime();
                attach_agents(&mut runtime, &root, &["source"]);
                let mut configuration = runtime.store.steward_configurations()[0].clone();
                configuration.playbook_evaluator = termloop_domain::PlaybookEvaluatorSettings {
                    codex_model: model.map(str::to_owned),
                    claude_model: Some("haiku".into()),
                    permission: permission.into(),
                };
                runtime
                    .store
                    .set_steward_configuration(
                        &runtime.write_authority,
                        configuration,
                        runtime.state_revision(),
                    )
                    .unwrap();
                let claim = runtime
                    .claim_next_playbook_step_or_idle(
                        &project,
                        "evaluation-check".into(),
                        termloop_platform::current_epoch_ms(),
                    )
                    .unwrap();
                let PlaybookEvaluationLaunch::Fork { mut plan, .. } =
                    runtime.plan_playbook_evaluation(&claim).unwrap()
                else {
                    panic!("expected evaluation fork");
                };
                let selection = plan.interactive_options.as_ref().unwrap();
                assert_eq!(selection.model, model.unwrap_or("gpt-6-astra"));
                assert_eq!(selection.permission, permission);
                assert_eq!(selection.reasoning, "high");
                plan.prepare_codex_fork_launch().unwrap();
                let launch = plan.prepared_launch.as_ref().unwrap();
                assert_eq!(
                    launch.inspectable_manifest().target.model,
                    model.unwrap_or("gpt-6-astra")
                );
                assert_eq!(
                    launch
                        .codex_resume_permissions()
                        .unwrap()
                        .permission()
                        .as_launch_selection(),
                    permission
                );
                let source = runtime
                    .store
                    .sessions()
                    .iter()
                    .find(|s| s.id == "source")
                    .unwrap();
                assert_eq!(source.launch_selection.model, "gpt-6-astra");
                assert_eq!(source.launch_selection.permission, "bypassPermissions");
                std::fs::remove_dir_all(root).unwrap();
            }
        }
    }

    fn remember_last_launch(runtime: &mut CoreRuntime) {
        let mut remembered = runtime
            .store
            .sessions()
            .iter()
            .find(|s| s.id == "steward-session")
            .unwrap()
            .clone();
        remembered.id = "remembered".into();
        remembered.process.template_ref = Some("builtin.agent.interactive".into());
        remembered.process.cwd = "/elsewhere".into();
        remembered.launch_selection =
            termloop_domain::AgentLaunchSelection::new("gpt-6-astra", "bypassPermissions", "high");
        runtime
            .store
            .insert_session_and_remember_agent_launch(&runtime.write_authority, remembered)
            .unwrap();
    }

    #[test]
    fn a_task_without_an_agent_waits_instead_of_getting_a_fresh_evaluator() {
        let (mut runtime, root, project) = pipeline_runtime();
        runtime.configure_agent_observations(crate::test_agent_observation_transport(root.clone()));
        remember_last_launch(&mut runtime);
        let claim = runtime
            .claim_next_playbook_step_or_idle(
                &project,
                "evaluation-check".into(),
                termloop_platform::current_epoch_ms(),
            )
            .unwrap();
        let PlaybookEvaluationLaunch::Skipped(result) =
            runtime.plan_playbook_evaluation(&claim).unwrap()
        else {
            panic!("a Task without an Agent must not launch an evaluator");
        };
        assert_eq!(result["evaluation"]["mode"], "waitingForTaskAgent");
        assert_eq!(result["evaluation"]["reason"], "noUnambiguousTaskAgent");
        assert!(runtime.store.playbook_evaluations().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_task_agent_that_cannot_fork_gets_a_fresh_evaluator_from_the_last_launch_selection() {
        let (mut runtime, root, project) = pipeline_runtime();
        crate::runtime::playbook_evaluation::tests::attach_agents(&mut runtime, &root, &["source"]);
        let mut transport = crate::test_agent_observation_transport(root.clone());
        for capability in transport.agents.values_mut() {
            capability.native_fork_supported = false;
        }
        runtime.configure_agent_observations(transport);
        remember_last_launch(&mut runtime);

        let claim = runtime
            .claim_next_playbook_step_or_idle(
                &project,
                "evaluation-check".into(),
                termloop_platform::current_epoch_ms(),
            )
            .unwrap();
        let PlaybookEvaluationLaunch::Fresh {
            plan,
            check_id,
            result,
        } = runtime.plan_playbook_evaluation(&claim).unwrap()
        else {
            panic!("a Task Agent that cannot fork must still be evaluated");
        };
        assert_eq!(plan.agent_id, "codex");
        assert!(matches!(
            plan.mcp_role,
            AgentMcpRole::PlaybookEvaluator { ref check_id } if check_id == "evaluation-check"
        ));
        assert!(plan.fork_source_ref.is_none());
        let selection = plan.interactive_options.as_ref().unwrap();
        assert_eq!(selection.model, "gpt-6-astra");
        // The evaluator's own permission applies, never the remembered one.
        assert_eq!(selection.permission, "plan");
        assert!(result["evaluation"]["sourceSessionId"].is_null());
        assert_eq!(result["evaluation"]["selection"], "freshEvaluator");
        let record = &runtime.store.playbook_evaluations()[0];
        assert!(record.source_session_id.is_none() && record.source_name.is_none());

        // A fresh evaluator that cannot start leaves the step waiting with its
        // own reason instead of a fork's.
        let deferred = runtime.fail_playbook_evaluation_launch(&check_id).unwrap();
        assert_eq!(deferred["evaluation"]["reason"], "evaluatorUnavailable");
        std::fs::remove_dir_all(root).unwrap();
    }
}
