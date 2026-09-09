//! Preview and launch for versioned Improve-with-agent sessions.

use serde_json::Value;

use super::super::super::AppState;
use super::super::super::agent_launch::execute_agent_launch;

pub(in crate::app::control) async fn preview_assistant_prompt_improver(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    state
        .core
        .lock()
        .await
        .preview_assistant_prompt_improver(params)
}

/// The improver redeems its own ticket kind but is otherwise an ordinary Agent
/// launch, so it shares the prepare-outside-the-lock sequence rather than
/// gaining a second launch path.
pub(in crate::app::control) async fn launch_assistant_prompt_improver(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let plan = {
        let mut core = state.core.lock().await;
        core.take_assistant_prompt_improver_launch(params)?
    };
    execute_agent_launch(state, plan).await
}
