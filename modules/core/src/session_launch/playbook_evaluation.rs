use serde_json::{Value, json};

use super::{AgentLaunchPlan, AgentMcpRole};
use crate::companion_integrations::tracker_runtime::StewardRoutineClaim;
use crate::{CoreError, CoreRuntime, required_string, store_error};
use termloop_domain::{PlaybookEvaluationOutcome as Outcome, PlaybookEvaluationRecord};

pub enum PlaybookEvaluationLaunch {
    Fork {
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
                &evaluation.source_session_id,
                &evaluation.session_id,
            )));
        }
        self.playbook_evaluation
            .waiting
            .remove(&capability.tracker_id);
        let Some(source) = self.select_playbook_source(&capability.project_id, &task_id, now)?
        else {
            return Ok(PlaybookEvaluationLaunch::Skipped(
                self.defer_playbook_evaluation(claim, "noUnambiguousTaskAgent")?,
            ));
        };
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
            return Ok(PlaybookEvaluationLaunch::Skipped(
                self.defer_playbook_evaluation(claim, "forkUnsupported")?,
            ));
        }
        let mut plan = match self.plan_agent_fork(json!({"sessionId": source})) {
            Ok(plan) if plan.mcp_token.is_some() => plan,
            _ => {
                return Ok(PlaybookEvaluationLaunch::Skipped(
                    self.defer_playbook_evaluation(claim, "forkUnavailable")?,
                ));
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
        Ok(PlaybookEvaluationLaunch::Fork {
            result: delegated_result(&capability.check_id, &source, &plan.session_id),
            check_id: capability.check_id.clone(),
            plan: Box::new(plan),
        })
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
        let source = self
            .store
            .sessions()
            .iter()
            .find(|s| s.id == evaluation.source_session_id)
            .ok_or(CoreError::NotFound)?;
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
            source_session_id: source.id.clone(),
            source_name: source.name.clone().unwrap_or_else(|| plan.agent_id.clone()),
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

fn delegated_result(check_id: &str, source: &str, evaluator: &str) -> Value {
    json!({"status": "delegated", "checkId": check_id, "evaluation": {
        "sourceSessionId": source, "sessionId": evaluator,
        "selection": "observedTaskWorkOrCanonicalAgent",
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
                    .claim_next_steward_routine(
                        &project,
                        "steward-session",
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
}
