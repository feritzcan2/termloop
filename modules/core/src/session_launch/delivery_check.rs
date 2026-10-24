use super::{AgentLaunchPlan, AgentMcpRole};
use crate::runtime::delivery_check::{DeliveryCheck, DeliveryCheckReason};
use crate::{CoreError, CoreRuntime};

/// A planned delivery check whose Agent the server launches.
pub struct DeliveryCheckLaunch {
    pub plan: Box<AgentLaunchPlan>,
    pub check_id: String,
    pub project_id: String,
    pub task_ids: Vec<String>,
}

impl CoreRuntime {
    /// Plans the delivery check the Project Manager asked for: of the named
    /// Tasks, or of every tracked Task of the Project.
    pub fn plan_requested_delivery_check(
        &mut self,
        params: &serde_json::Value,
    ) -> Result<Option<DeliveryCheckLaunch>, CoreError> {
        let project_id = crate::required_string(params, "projectId")?;
        let task_ids = Self::requested_check_task_ids(params)?;
        self.plan_delivery_check(&project_id, task_ids, DeliveryCheckReason::Requested, None)
    }

    /// Plans one delivery check of a Project Manager Project's Tasks, in the
    /// Project checkout with the last ordinary Agent provider and launch
    /// selection. `Ok(None)` when a running check already covers one of the
    /// Tasks.
    pub fn plan_delivery_check(
        &mut self,
        project_id: &str,
        task_ids: Option<Vec<String>>,
        reason: DeliveryCheckReason,
        context: Option<String>,
    ) -> Result<Option<DeliveryCheckLaunch>, CoreError> {
        let task_ids = self.delivery_check_scope(project_id, task_ids)?;
        if task_ids
            .iter()
            .any(|task_id| self.delivery_check_covers(project_id, task_id))
        {
            return Ok(None);
        }
        let saved = self
            .store
            .last_agent_launch_selection()
            .cloned()
            .ok_or(CoreError::AgentUnsupported)?;
        if termloop_agents::executable_for(&saved.agent_id).is_none()
            || !self
                .observation_transport
                .as_ref()
                .is_some_and(|transport| transport.mcp_http_supported(&saved.agent_id))
        {
            return Err(CoreError::AgentUnsupported);
        }
        let cwd = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .ok_or(CoreError::NotFound)?
            .folder_path
            .clone();
        self.ensure_launch_not_reserved(std::path::Path::new(&cwd))?;
        let check_id = termloop_platform::generate_opaque_id();
        let mut plan = self.plan_agent_launch_at(
            project_id.to_owned(),
            cwd,
            saved.agent_id.clone(),
            uuid::Uuid::new_v4().to_string(),
            AgentMcpRole::DeliveryCheck {
                check_id: check_id.clone(),
            },
        )?;
        if plan.mcp_token.is_none() {
            return Err(CoreError::AgentUnsupported);
        }
        plan.set_account(
            self.resolve_agent_account(&saved.agent_id, saved.selection.account_id.as_deref())?,
        );
        plan.interactive_options = Some(saved.selection);
        plan.fork_name = Some("Delivery check".into());
        self.reserve_delivery_check(
            check_id.clone(),
            DeliveryCheck::starting(
                project_id.to_owned(),
                task_ids.clone(),
                reason,
                context,
                plan.session_id.clone(),
                plan.runtime_epoch,
            ),
        )?;
        Ok(Some(DeliveryCheckLaunch {
            plan: Box::new(plan),
            check_id,
            project_id: project_id.to_owned(),
            task_ids,
        }))
    }

    pub(super) fn revalidate_delivery_check_launch(
        &self,
        plan: &AgentLaunchPlan,
    ) -> Result<(), CoreError> {
        if let AgentMcpRole::DeliveryCheck { check_id } = &plan.mcp_role {
            let check = self
                .delivery_checks
                .checks
                .get(check_id)
                .filter(|check| {
                    check.session_id == plan.session_id && check.runtime_epoch == plan.runtime_epoch
                })
                .ok_or(CoreError::TrackerReportStale)?;
            if !self.is_project_manager_project(&check.project_id) {
                return Err(CoreError::TrackerReportStale);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_launches_in_the_project_checkout_with_the_last_ordinary_selection() {
        let (mut runtime, root, project_id) =
            crate::runtime::delivery_check::tests::project_manager_runtime();
        let launch = runtime
            .plan_delivery_check(&project_id, None, DeliveryCheckReason::Requested, None)
            .unwrap()
            .unwrap();
        let folder = runtime
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .unwrap()
            .folder_path
            .clone();
        assert_eq!(launch.plan.cwd, folder);
        assert_eq!(launch.plan.agent_id, "codex");
        assert!(launch.plan.task_guard.is_none(), "a check has no worktree");
        assert!(matches!(
            &launch.plan.mcp_role,
            AgentMcpRole::DeliveryCheck { check_id } if *check_id == launch.check_id
        ));
        assert_eq!(
            launch.plan.interactive_options.as_ref().unwrap().model,
            "gpt-6-astra"
        );
        assert_eq!(launch.plan.fork_name.as_deref(), Some("Delivery check"));
        runtime
            .revalidate_delivery_check_launch(&launch.plan)
            .unwrap();
        runtime.fail_delivery_check_launch(&launch.check_id);
        assert!(matches!(
            runtime.revalidate_delivery_check_launch(&launch.plan),
            Err(CoreError::TrackerReportStale)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}
