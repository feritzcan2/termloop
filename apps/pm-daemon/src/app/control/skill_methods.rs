//! Method handlers for skills and the suggestions they make: the skills
//! list, enabling, the PM's own edits, installing a reviewed draft, runs,
//! the skill creator, feedback, and accepting or rejecting a suggestion.

use serde_json::{Value, json};
use termloop_pm::agent::SkillSetup;
use termloop_pm::skill::{SkillEdit, SkillRunTrigger};
use termloop_pm_contract::pm::{
    PmProjectRef, PmProposalAcceptParams, PmProposalRejectParams, PmSkillCreatorLaunchParams,
    PmSkillDraftRef, PmSkillInstallParams, PmSkillRef, PmSkillSetEnabledParams, PmSkillSetup,
    PmSkillUpdateParams,
};

use super::dispatch::{parse, require_project, require_ticket, to_value};
use super::errors::{ControlError, invalid_parameter, not_found};
use crate::app::skills::CreatorLaunch;
use crate::app::{AppState, skills};

pub(super) fn skills_read(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmProjectRef = parse(params)?;
    let store = state.store.lock();
    require_project(&store, &params.project_id)?;
    skills::skills_value(&store, &params.project_id)
}

pub(super) fn suggestions_read(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmProjectRef = parse(params)?;
    let store = state.store.lock();
    require_project(&store, &params.project_id)?;
    Ok(json!({
        "projectId": params.project_id,
        "proposals": to_value(&store.skill_suggestions(&params.project_id)?)?,
    }))
}

pub(super) fn set_enabled(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmSkillSetEnabledParams = parse(params)?;
    let skill = state
        .store
        .lock()
        .set_skill_enabled(&params.skill_id, params.enabled)?;
    skills::publish(state, &skill.project_id);
    to_value(&skill)
}

pub(super) fn update(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmSkillUpdateParams = parse(params)?;
    let skill = state.store.lock().update_skill(
        &params.skill_id,
        SkillEdit {
            name: params.name,
            description: params.description,
            instructions: params.instructions,
        },
    )?;
    skills::publish(state, &skill.project_id);
    to_value(&skill)
}

pub(super) fn install(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmSkillInstallParams = parse(params)?;
    let skill = state.store.lock().install_skill_draft(
        &params.draft_id,
        &params.approved_tools,
        params.channels.as_deref(),
    )?;
    skills::publish(state, &skill.project_id);
    to_value(&skill)
}

pub(super) fn run(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmSkillRef = parse(params)?;
    skills::run(state, &params.skill_id, SkillRunTrigger::Manual)
}

pub(super) fn creator_launch(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmSkillCreatorLaunchParams = parse(params)?;
    require_project(&state.store.lock(), &params.project_id)?;
    let launch = match (params.skill_id.as_deref(), params.setup) {
        (None, None) => CreatorLaunch::Offer,
        (Some(skill_id), None) => CreatorLaunch::Revise(skill_id),
        (None, Some(setup)) => CreatorLaunch::Setup(match setup {
            PmSkillSetup::Playbook => SkillSetup::Playbook,
            PmSkillSetup::BugOwnerFinder => SkillSetup::BugOwnerFinder,
            PmSkillSetup::SlackTracker => SkillSetup::SlackTracker,
        }),
        (Some(_), Some(_)) => return Err(invalid_parameter("setup")),
    };
    Ok(skills::launch_creator(state, &params.project_id, launch)?.value())
}

pub(super) fn feedback_read(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmSkillRef = parse(params)?;
    let store = state.store.lock();
    store.skill(&params.skill_id)?.ok_or_else(not_found)?;
    Ok(json!({
        "skillId": params.skill_id,
        "feedback": to_value(&store.skill_feedback(&params.skill_id)?)?,
        "runs": to_value(&store.skill_runs(&params.skill_id)?)?,
    }))
}

pub(super) fn draft_dry_run(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmSkillDraftRef = parse(params)?;
    to_value(&skills::dry_run(state, &params.draft_id)?)
}

pub(super) fn draft_discard(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmSkillDraftRef = parse(params)?;
    let draft = state.store.lock().discard_skill_draft(&params.draft_id)?;
    skills::publish(state, &draft.project_id);
    Ok(json!({ "discarded": true }))
}

/// Accepts a suggestion; an assignee suggestion takes the shortlisted
/// person the PM picked. A skill's suggestion also updates its skill.
pub(super) fn proposal_accept(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmProposalAcceptParams = parse(params)?;
    let (ticket, from_skill) = {
        let mut store = state.store.lock();
        let proposal = store.proposal(&params.proposal_id)?.ok_or_else(not_found)?;
        let ticket =
            store.accept_ticket_proposal_as(&params.proposal_id, params.assignee.as_deref())?;
        (ticket, proposal.skill_id.is_some())
    };
    state.board_changed(&ticket.project_id);
    if from_skill {
        skills::publish(state, &ticket.project_id);
    }
    to_value(&ticket)
}

pub(super) fn proposal_reject(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmProposalRejectParams = parse(params)?;
    let (project_id, from_skill) = {
        let mut store = state.store.lock();
        let proposal = store.proposal(&params.proposal_id)?.ok_or_else(not_found)?;
        let project_id = require_ticket(&store, &proposal.ticket_id)?.project_id;
        store.reject_ticket_proposal_because(&params.proposal_id, params.reason.as_deref())?;
        (project_id, proposal.skill_id.is_some())
    };
    state.board_changed(&project_id);
    if from_skill {
        skills::publish(state, &project_id);
    }
    Ok(json!({ "rejected": true }))
}

/// The tools checklist: the cached discovery unless `refresh` asks to
/// read the machine again.
pub(super) async fn tools_read(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: termloop_pm_contract::pm::PmToolsReadParams = parse(params)?;
    require_project(&state.store.lock(), &params.project_id)?;
    let tools =
        crate::app::tool_list::read(state, &params.project_id, params.refresh.unwrap_or(false))
            .await?;
    to_value(&tools)
}
