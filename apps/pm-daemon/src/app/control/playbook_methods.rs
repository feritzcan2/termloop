//! Method handlers for a project's Playbook: the PM's own saves, applying or
//! discarding what a Playbook setup proposed, and marking a ticket's step by
//! hand. Each one changes where tickets stand, so it publishes
//! `pmBoardChanged` and wakes skills reading the Playbook.

use serde_json::{Value, json};
use termloop_pm::playbook::PlaybookStep;
use termloop_pm::skill::SkillEvent;
use termloop_pm_contract::pm::{
    PmPlaybookProposalApplyParams, PmPlaybookSaveParams, PmPlaybookStepMarkParams, PmProjectRef,
};

use super::dispatch::{convert, parse, require_project, require_ticket, to_value};
use super::errors::{ControlError, not_found};
use crate::app::{AppState, skills};

pub(super) fn save(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmPlaybookSaveParams = parse(params)?;
    let steps: Vec<PlaybookStep> = convert(&params.steps)?;
    let playbook = {
        let mut store = state.store.lock();
        require_project(&store, &params.project_id)?;
        store.save_playbook(&params.project_id, params.base_revision, steps)?
    };
    playbook_changed(state, &params.project_id);
    to_value(&playbook)
}

/// Saves the steps the PM kept from the setup's proposal, as edited.
pub(super) fn proposal_apply(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmPlaybookProposalApplyParams = parse(params)?;
    let steps: Vec<PlaybookStep> = convert(&params.steps)?;
    let playbook = {
        let mut store = state.store.lock();
        require_project(&store, &params.project_id)?;
        store.apply_playbook_proposal(&params.project_id, steps)?
    };
    playbook_changed(state, &params.project_id);
    skills::publish(state, &params.project_id);
    to_value(&playbook)
}

pub(super) fn proposal_discard(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmProjectRef = parse(params)?;
    {
        let mut store = state.store.lock();
        require_project(&store, &params.project_id)?;
        store.discard_playbook_proposal(&params.project_id)?;
    }
    skills::publish(state, &params.project_id);
    Ok(json!({ "discarded": true }))
}

/// The PM's own answer for one step of one ticket; returns the ticket's
/// delivery as it now stands.
pub(super) fn step_mark(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmPlaybookStepMarkParams = parse(params)?;
    let (project_id, delivery) = {
        let mut store = state.store.lock();
        let ticket = require_ticket(&store, &params.ticket_id)?;
        store.mark_step(&ticket.id, &params.step_id, params.passed)?;
        let delivery = store
            .board(&ticket.project_id)?
            .deliveries
            .into_iter()
            .find(|delivery| delivery.ticket_id == ticket.id)
            .ok_or_else(not_found)?;
        (ticket.project_id, delivery)
    };
    playbook_changed(state, &project_id);
    to_value(&delivery)
}

fn playbook_changed(state: &AppState, project_id: &str) {
    state.board_changed(project_id);
    skills::note_event(state, project_id, SkillEvent::DeployChanged);
}
