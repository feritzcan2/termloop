//! Method handlers for a project's epics: the PM's own edits and accepting
//! or rejecting what an assistant's breakdown proposed. Each one changes the
//! board, so it publishes `pmBoardChanged`.

use serde_json::{Value, json};
use termloop_pm::EpicEdit;
use termloop_pm::skill::SkillEvent;
use termloop_pm_contract::pm::{
    PmEpicBreakdownAcceptParams, PmEpicBreakdownRef, PmEpicCreateParams, PmEpicRef,
    PmEpicUpdateParams,
};

use super::dispatch::{parse, require_project, to_value};
use super::errors::{ControlError, not_found};
use crate::app::{AppState, skills};

pub(super) fn create(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmEpicCreateParams = parse(params)?;
    let epic = {
        let mut store = state.store.lock();
        require_project(&store, &params.project_id)?;
        store.create_epic(
            &params.project_id,
            &params.title,
            params.description.as_deref().unwrap_or_default(),
        )?
    };
    epics_changed(state, &epic.project_id);
    to_value(&epic)
}

pub(super) fn update(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmEpicUpdateParams = parse(params)?;
    let epic = state.store.lock().update_epic(
        &params.epic_id,
        EpicEdit {
            title: params.title,
            description: params.description,
        },
    )?;
    epics_changed(state, &epic.project_id);
    to_value(&epic)
}

/// Deletes an epic; its tickets stay and belong to no epic.
pub(super) fn delete(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmEpicRef = parse(params)?;
    let project_id = {
        let mut store = state.store.lock();
        let epic = store.epic(&params.epic_id)?.ok_or_else(not_found)?;
        store.delete_epic(&epic.id)?;
        epic.project_id
    };
    epics_changed(state, &project_id);
    Ok(json!({ "deleted": true }))
}

/// Creates the kept tasks (by index) as tickets under the breakdown's epic.
pub(super) fn breakdown_accept(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmEpicBreakdownAcceptParams = parse(params)?;
    let indices: Vec<usize> = params
        .task_indices
        .iter()
        .map(|index| *index as usize)
        .collect();
    let accepted = state.store.lock().accept_epic_breakdown(
        &params.breakdown_id,
        &indices,
        params.sprint_id.as_deref(),
    )?;
    epics_changed(state, &accepted.epic.project_id);
    Ok(json!({
        "epic": to_value(&accepted.epic)?,
        "tickets": to_value(&accepted.tickets)?,
    }))
}

pub(super) fn breakdown_reject(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmEpicBreakdownRef = parse(params)?;
    let project_id = {
        let mut store = state.store.lock();
        let breakdown = store
            .epic_breakdown(&params.breakdown_id)?
            .ok_or_else(not_found)?;
        store.reject_epic_breakdown(&breakdown.id)?;
        breakdown.project_id
    };
    state.board_changed(&project_id);
    Ok(json!({ "rejected": true }))
}

/// The PM's own epic edits wake skills waiting for board changes.
fn epics_changed(state: &AppState, project_id: &str) {
    state.board_changed(project_id);
    skills::note_event(state, project_id, SkillEvent::BoardChanged);
}
