//! Steward-started independent Project Agents.
//!
//! The Steward may start an ordinary Agent in the Project's own checkout
//! without a Task. The launch reuses the free-prompt Quick Action path, so the
//! delivered first instruction stays invocation-composed and inspectable; only
//! the Steward authority check, the selection defaults, and the rail name are
//! owned here.

use serde_json::json;

use super::AgentLaunchPlan;
use crate::{CoreError, CoreRuntime};

const DEFAULT_AGENT_ID: &str = "claude";
const DEFAULT_CLAUDE_MODEL: &str = "opus";
const DEFAULT_REASONING: &str = "medium";
const TITLE_MAX_CHARS: usize = 80;

/// One Steward request to start an independent Project Agent. Every optional
/// selection field independently falls back to the Steward default.
#[derive(Debug, Clone, Copy)]
pub struct StewardProjectAgentRequest<'a> {
    pub title: &'a str,
    pub assignment: &'a str,
    pub agent_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub permission: Option<&'a str>,
    pub reasoning: Option<&'a str>,
    /// Keep the Agent out of History once it leaves the active rail.
    pub hide_in_archive: bool,
}

impl CoreRuntime {
    /// Plans an independent Agent in the authenticated Steward's own Project
    /// checkout. The Project comes from the authenticated principal, never from
    /// the caller, and the launch never replaces the remembered user selection.
    pub fn plan_steward_project_agent_start(
        &self,
        steward_session_id: &str,
        project_id: &str,
        request: StewardProjectAgentRequest<'_>,
    ) -> Result<AgentLaunchPlan, CoreError> {
        if !self.is_current_steward_session(project_id, steward_session_id) {
            return Err(CoreError::CapabilityDenied);
        }
        let title = request.title.trim();
        if title.is_empty()
            || title.chars().count() > TITLE_MAX_CHARS
            || title.chars().any(char::is_control)
        {
            return Err(CoreError::InvalidParams("title".into()));
        }
        let agent_id = request.agent_id.unwrap_or(DEFAULT_AGENT_ID);
        if !matches!(agent_id, "claude" | "codex") {
            return Err(CoreError::InvalidParams("agentId".into()));
        }
        let model = request.model.unwrap_or(match agent_id {
            "claude" => DEFAULT_CLAUDE_MODEL,
            _ => "default",
        });
        let permission = request
            .permission
            .unwrap_or_else(|| termloop_invocation::default_permission(agent_id));
        let reasoning = request.reasoning.unwrap_or(DEFAULT_REASONING);
        let cwd = self.project_checkout_path(project_id)?;
        let mut plan = self.plan_quick_action_launch(json!({
            "projectId": project_id,
            "cwd": cwd,
            "agentId": agent_id,
            "model": model,
            "permission": permission,
            "reasoning": reasoning,
            "templateRef": termloop_invocation::QUICK_ACTION_FREE_PROMPT_TEMPLATE_REF,
            "bindings": { "prompt": request.assignment },
            "attachments": [],
        }))?;
        plan.steward_agent_name = Some(title.to_owned());
        plan.hide_in_archive = request.hide_in_archive;
        Ok(plan)
    }
}

impl AgentLaunchPlan {
    /// The effective selection a Steward-started Project Agent launches with.
    pub fn steward_agent_selection(&self) -> Option<&termloop_domain::AgentLaunchSelection> {
        self.quick_action.as_ref().map(|action| &action.selection)
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn steward_agent_name(&self) -> Option<&str> {
        self.steward_agent_name.as_deref()
    }

    pub fn hides_in_archive(&self) -> bool {
        self.hide_in_archive
    }
}
