use serde_json::{Value, json};

use super::{AgentLaunchPlan, AgentMcpRole};
use crate::companion_integrations::tracker_runtime::StewardRoutineClaim;
use crate::{CoreError, CoreRuntime};

pub enum PlaybookEvaluationLaunch {
    Fork {
        plan: Box<AgentLaunchPlan>,
        check_id: String,
        result: Value,
    },
    Delegated(Value),
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
        // These are current claims, not a history of evaluations.
        let current_checks = self.tracker_runtime.active_check_ids();
        self.playbook_evaluation
            .fallbacks
            .retain(|id, _| current_checks.contains(id));
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
        if let Some(reason) = self.playbook_evaluation.fallbacks.get(&capability.check_id) {
            return Ok(PlaybookEvaluationLaunch::Steward(fallback_result(
                &claim.result,
                reason,
            )));
        }
        let Some(source) = self.select_playbook_source(&capability.project_id, &task_id, now)?
        else {
            return Ok(PlaybookEvaluationLaunch::Steward(fallback_result(
                &claim.result,
                "noUnambiguousTaskAgent",
            )));
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
            return Ok(PlaybookEvaluationLaunch::Steward(fallback_result(
                &claim.result,
                "forkUnsupported",
            )));
        }
        let mut plan = match self.plan_agent_fork(json!({"sessionId": source})) {
            Ok(plan) if plan.mcp_token.is_some() => plan,
            _ => {
                return Ok(PlaybookEvaluationLaunch::Steward(fallback_result(
                    &claim.result,
                    "forkUnavailable",
                )));
            }
        };
        plan.mcp_role = AgentMcpRole::PlaybookEvaluator {
            check_id: capability.check_id.clone(),
        };
        plan.interactive_options.get_or_insert_default().permission = "plan".into();
        plan.fork_name = Some("Playbook evaluation".into());
        match self.reserve_playbook_evaluation(
            claim,
            source.clone(),
            plan.session_id.clone(),
            plan.runtime_epoch,
        ) {
            Ok(()) => {}
            Err(CoreError::HelperCapacityExhausted) => {
                return Ok(PlaybookEvaluationLaunch::Steward(fallback_result(
                    &claim.result,
                    "evaluationCapacity",
                )));
            }
            Err(error) => return Err(error),
        }
        Ok(PlaybookEvaluationLaunch::Fork {
            result: delegated_result(&capability.check_id, &source, &plan.session_id),
            check_id: capability.check_id.clone(),
            plan: Box::new(plan),
        })
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

fn fallback_result(assignment: &Value, reason: &str) -> Value {
    let mut value = assignment.clone();
    value["evaluation"] = json!({"mode": "stewardFallback", "reason": reason});
    value
}
