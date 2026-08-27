use termloop_domain::{DurableAgentPlan, DurableAgentPlanSource, SessionKind};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn replace_agent_plan(
        &mut self,
        _authority: &CoreWriteAuthority,
        plan: DurableAgentPlan,
    ) -> Result<u64, StoreError> {
        if !plan.is_well_formed() || !plan_matches_session(self, &plan) {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        match self
            .state
            .agent_plans
            .iter()
            .position(|current| current.session_id == plan.session_id)
        {
            Some(index) if self.state.agent_plans[index] == plan => return Ok(self.state.revision),
            Some(index) => self.state.agent_plans[index] = plan,
            None => self.state.agent_plans.push(plan),
        }
        self.commit_or_restore(previous)
    }

    pub fn clear_agent_plan(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
    ) -> Result<u64, StoreError> {
        if !self
            .state
            .sessions
            .iter()
            .any(|session| session.id == session_id && session.kind == SessionKind::Agent)
        {
            return Err(StoreError::NotFound);
        }
        let previous = self.state.clone();
        let before = self.state.agent_plans.len();
        self.state
            .agent_plans
            .retain(|plan| plan.session_id != session_id);
        if self.state.agent_plans.len() == before {
            return Ok(self.state.revision);
        }
        self.commit_or_restore(previous)
    }
}

fn plan_matches_session(store: &Store, plan: &DurableAgentPlan) -> bool {
    store.state.sessions.iter().any(|session| {
        session.id == plan.session_id
            && session.kind == SessionKind::Agent
            && matches!(
                (session.process.agent_id.as_deref(), plan.source),
                (Some("claude"), DurableAgentPlanSource::ClaudeHook)
                    | (Some("codex"), DurableAgentPlanSource::CodexAppServer)
            )
    })
}

pub(super) fn remove_agent_plans_for_sessions(
    state: &mut crate::CurrentState,
    session_ids: impl IntoIterator<Item = impl AsRef<str>>,
) -> bool {
    let session_ids = session_ids
        .into_iter()
        .map(|value| value.as_ref().to_owned())
        .collect::<std::collections::HashSet<_>>();
    let before = state.agent_plans.len();
    state
        .agent_plans
        .retain(|plan| !session_ids.contains(&plan.session_id));
    before != state.agent_plans.len()
}
