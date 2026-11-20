use std::sync::atomic::Ordering;

use serde_json::{Value, json};
use termloop_contract::current::{McpStewardProjectAgentStartParams, ProjectionTopic};
use termloop_core::{CoreError, StewardProjectAgentRequest};

use super::AppState;
use super::agent_launch::execute_agent_launch;
use super::invalidation::InvalidationRequest;

/// Starts one independent ordinary Agent in the Steward's own Project checkout.
/// Core authorizes the Steward and plans the inspected free-prompt launch; this
/// composition root only executes it and records the visible action receipt.
pub(super) async fn start(
    project_id: &str,
    steward_session_id: &str,
    params: McpStewardProjectAgentStartParams,
    state: &AppState,
) -> Result<Value, CoreError> {
    let plan = state.core.lock().await.plan_steward_project_agent_start(
        steward_session_id,
        project_id,
        StewardProjectAgentRequest {
            title: &params.title,
            assignment: &params.assignment,
            agent_id: params.agent_id.as_deref(),
            model: params.model.as_deref(),
            permission: params.permission.as_deref(),
            reasoning: params.reasoning.as_deref(),
        },
    )?;
    let selection = plan
        .steward_agent_selection()
        .cloned()
        .ok_or_else(|| CoreError::InvalidParams("assignment".into()))?;
    let title = plan.steward_agent_name().unwrap_or_default().to_owned();
    let agent_id = plan.agent_id().to_owned();
    let cwd = plan.cwd().to_owned();

    let launched = execute_agent_launch(state, plan).await?;
    let session_id = launched
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Terminal("launched Agent has no Session ID".into()))?
        .to_owned();

    let state_revision = {
        let mut core = state.core.lock().await;
        // The launch is already authoritative; a full transcript must not turn
        // it into an ambiguous failure that invites a duplicate start.
        let _ = core.append_steward_action(
            steward_session_id,
            project_id,
            &format!("Started Project Agent \"{title}\"."),
            None,
            Some(session_id.clone()),
            super::current_epoch_ms(),
        );
        core.state_revision()
    };
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Companion, ProjectionTopic::Steward],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });

    Ok(json!({
        "sessionId": session_id,
        "title": title,
        "cwd": cwd,
        "agentId": agent_id,
        "model": selection.model,
        "permission": selection.permission,
        "reasoning": selection.reasoning,
        "status": "launched",
    }))
}
