//! Method dispatch for the planning surface: projects, sprints, tickets,
//! proposals, sources, the Playbook, and skills. Each mutation
//! publishes `pmBoardChanged` for its project.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use termloop_pm::skill::SkillEvent;
use termloop_pm::{
    DeliveryCheck, NewTicket, NewTicketNote, PmStore, ProjectSources, Ticket, TicketAuthor,
    TicketEdit,
};
use termloop_pm_contract::pm::{
    CONTRACT_IDENTITY, ErrorCode, PmDigestReadParams, PmProjectRef, PmSourcesSetParams,
    PmSprintCloseParams, PmSprintCreateParams, PmSprintRef, PmSprintUpdateParams,
    PmTicketBlockerAddParams, PmTicketBlockerRemoveParams, PmTicketCreateParams,
    PmTicketCriterionAddParams, PmTicketCriterionRemoveParams, PmTicketCriterionSetDoneParams,
    PmTicketDescriptionSaveParams, PmTicketMoveParams, PmTicketNoteAddParams, PmTicketNoteRef,
    PmTicketRef, PmTicketUpdateParams,
};

use super::errors::{ControlError, error, internal, not_found};
use super::{operations, playbook_methods, skill_methods};
use crate::app::{AppState, jira_browse, skills};

const PRODUCT: &str = "termloop-pm";
const TERMINAL_DATA_PLANE: &str = "binary-websocket";

pub(crate) async fn dispatch(
    state: &AppState,
    method: &str,
    params: &Value,
) -> Result<Value, ControlError> {
    match method {
        "pm_system_version" => Ok(json!({
            "product": PRODUCT,
            "version": env!("CARGO_PKG_VERSION"),
            "protocolVersion": CONTRACT_IDENTITY,
            "terminalDataPlane": TERMINAL_DATA_PLANE,
        })),
        "pm_project_create" => operations::project_create(state, params).await,
        "pm_project_update" => operations::project_update(state, params).await,
        "pm_credential_store" => operations::credential_store(state, params),
        "pm_credential_clear" => operations::credential_clear(state, params),
        "pm_check_start" => operations::check_start(state, params).await,
        "pm_checks_read" => operations::checks_read(state, params),
        "pm_jira_pull" => operations::jira_pull(state, params).await,
        "pm_jira_diff_read" => operations::jira_diff_read(state, params).await,
        "pm_jira_apply" => operations::jira_apply(state, params).await,
        "pm_jira_projects_read" => jira_browse::projects_read(state, parse(params)?).await,
        "pm_jira_statuses_read" => jira_browse::statuses_read(state, parse(params)?).await,
        "pm_jira_favourite_filters_read" => {
            jira_browse::favourite_filters_read(state, parse(params)?).await
        }
        "pm_jira_search" => jira_browse::search(state, parse(params)?).await,
        "pm_agent_launch" => operations::agent_launch(state, params),
        "pm_agent_list" => operations::agent_list(state, params),
        "pm_agent_stop" => operations::agent_stop(state, params),
        "pm_agent_catalog_read" => operations::agent_catalog_read(),
        "pm_settings_read" => operations::settings_read(state),
        "pm_settings_update" => operations::settings_update(state, params),
        "pm_skills_read" => skill_methods::skills_read(state, params),
        "pm_tools_read" => skill_methods::tools_read(state, params).await,
        "pm_skill_suggestions_read" => skill_methods::suggestions_read(state, params),
        "pm_skill_set_enabled" => skill_methods::set_enabled(state, params),
        "pm_skill_update" => skill_methods::update(state, params),
        "pm_skill_install" => skill_methods::install(state, params),
        "pm_skill_run" => skill_methods::run(state, params),
        "pm_skill_creator_launch" => skill_methods::creator_launch(state, params),
        "pm_skill_feedback_read" => skill_methods::feedback_read(state, params),
        "pm_skill_draft_dry_run" => skill_methods::draft_dry_run(state, params),
        "pm_skill_draft_discard" => skill_methods::draft_discard(state, params),
        "pm_playbook_save" => playbook_methods::save(state, params),
        "pm_playbook_proposal_apply" => playbook_methods::proposal_apply(state, params),
        "pm_playbook_proposal_discard" => playbook_methods::proposal_discard(state, params),
        "pm_playbook_step_mark" => playbook_methods::step_mark(state, params),
        "pm_ticket_proposal_accept" => skill_methods::proposal_accept(state, params),
        "pm_ticket_proposal_reject" => skill_methods::proposal_reject(state, params),
        _ => {
            let result = planning(state, method, params)?;
            if BOARD_EDITS.contains(&method)
                && let Some(project_id) = result.get("projectId").and_then(Value::as_str)
            {
                skills::note_event(state, project_id, SkillEvent::BoardChanged);
            }
            Ok(result)
        }
    }
}

/// The PM's own board edits, which wake skills waiting for board changes.
/// Agent writes do not, so a skill never wakes itself.
const BOARD_EDITS: &[&str] = &[
    "pm_ticket_create",
    "pm_ticket_update",
    "pm_ticket_move",
    "pm_ticket_description_save",
    "pm_ticket_blocker_add",
    "pm_ticket_blocker_remove",
    "pm_ticket_criterion_add",
    "pm_ticket_criterion_set_done",
    "pm_ticket_criterion_remove",
];

fn planning(state: &AppState, method: &str, params: &Value) -> Result<Value, ControlError> {
    let mut store = state.store.lock();
    let store = &mut *store;
    match method {
        "pm_project_list" => Ok(json!({ "projects": to_value(&store.projects()?)? })),
        "pm_board_read" => {
            let params: PmProjectRef = parse(params)?;
            require_project(store, &params.project_id)?;
            board(state, store, &params.project_id)
        }
        "pm_digest_read" => {
            let params: PmDigestReadParams = parse(params)?;
            require_project(store, &params.project_id)?;
            to_value(&store.digest(&params.project_id, params.since_epoch_ms)?)
        }
        "pm_sprint_create" => sprint_create(state, store, params),
        "pm_sprint_update" => sprint_update(state, store, params),
        "pm_sprint_activate" => {
            let params: PmSprintRef = parse(params)?;
            let sprint = store.activate_sprint(&params.sprint_id)?;
            state.board_changed(&sprint.project_id);
            to_value(&sprint)
        }
        "pm_sprint_close" => {
            let params: PmSprintCloseParams = parse(params)?;
            let closed = store.close_sprint(&params.sprint_id, params.carry_over_to.as_deref())?;
            state.board_changed(&closed.sprint.project_id);
            to_value(&closed)
        }
        "pm_ticket_create" => ticket_create(state, store, params),
        "pm_ticket_update" => ticket_update(state, store, params),
        "pm_ticket_move" => ticket_move(state, store, params),
        "pm_ticket_description_save" => {
            let params: PmTicketDescriptionSaveParams = parse(params)?;
            store.save_ticket_description(
                &params.ticket_id,
                &params.description,
                TicketAuthor::Pm,
                Some(params.base_version),
            )?;
            changed_ticket(state, store, &params.ticket_id)
        }
        "pm_ticket_versions_read" => {
            let params: PmTicketRef = parse(params)?;
            require_ticket(store, &params.ticket_id)?;
            Ok(json!({
                "ticketId": params.ticket_id,
                "versions": to_value(&store.ticket_versions(&params.ticket_id)?)?,
            }))
        }
        "pm_ticket_blocker_add" => {
            let params: PmTicketBlockerAddParams = parse(params)?;
            store.add_ticket_blocker(&params.ticket_id, &params.text)?;
            changed_ticket(state, store, &params.ticket_id)
        }
        "pm_ticket_blocker_remove" => {
            let params: PmTicketBlockerRemoveParams = parse(params)?;
            let ticket = store.remove_ticket_blocker(&params.ticket_id, &params.blocker_id)?;
            published_ticket(state, &ticket)
        }
        "pm_ticket_criterion_add" => {
            let params: PmTicketCriterionAddParams = parse(params)?;
            store.add_acceptance_criterion(&params.ticket_id, &params.text)?;
            changed_ticket(state, store, &params.ticket_id)
        }
        "pm_ticket_criterion_set_done" => {
            let params: PmTicketCriterionSetDoneParams = parse(params)?;
            let ticket = store.set_acceptance_criterion_done(
                &params.ticket_id,
                &params.criterion_id,
                params.done,
            )?;
            published_ticket(state, &ticket)
        }
        "pm_ticket_criterion_remove" => {
            let params: PmTicketCriterionRemoveParams = parse(params)?;
            let ticket =
                store.remove_acceptance_criterion(&params.ticket_id, &params.criterion_id)?;
            published_ticket(state, &ticket)
        }
        "pm_ticket_proposals_read" => {
            let params: PmTicketRef = parse(params)?;
            require_ticket(store, &params.ticket_id)?;
            Ok(json!({
                "ticketId": params.ticket_id,
                "proposals": to_value(&store.ticket_proposals(&params.ticket_id)?)?,
            }))
        }
        "pm_ticket_notes_read" => {
            let params: PmTicketRef = parse(params)?;
            Ok(json!({
                "ticketId": params.ticket_id,
                "notes": to_value(&store.ticket_notes(&params.ticket_id)?)?,
            }))
        }
        "pm_ticket_note_add" => {
            let params: PmTicketNoteAddParams = parse(params)?;
            let note = store.add_ticket_note(NewTicketNote {
                kind: convert(&params.kind)?,
                text: params.text.trim().to_owned(),
                ticket_id: params.ticket_id,
                url: params.url,
                source_key: None,
                author: TicketAuthor::Pm,
            })?;
            changed_ticket(state, store, &note.ticket_id)?;
            to_value(&note)
        }
        "pm_ticket_note_remove" => {
            let params: PmTicketNoteRef = parse(params)?;
            let note = store.ticket_note(&params.note_id)?;
            store.remove_ticket_note(&note.id)?;
            changed_ticket(state, store, &note.ticket_id)?;
            Ok(json!({ "deleted": true }))
        }
        "pm_sources_read" => {
            let params: PmProjectRef = parse(params)?;
            require_project(store, &params.project_id)?;
            sources(
                &params.project_id,
                &store.project_sources(&params.project_id)?,
            )
        }
        "pm_sources_set" => {
            let params: PmSourcesSetParams = parse(params)?;
            require_project(store, &params.project_id)?;
            // The code host follows the project folder, so only Jira is set here.
            let wanted = ProjectSources {
                jira: params.jira.as_ref().map(convert).transpose()?,
                ..store.project_sources(&params.project_id)?
            };
            let stored = store.set_project_sources(&params.project_id, &wanted)?;
            state.board_changed(&params.project_id);
            state.fact_refresh.notify_one();
            sources(&params.project_id, &stored)
        }
        _ => Err(error(ErrorCode::MethodNotFound, "unknown method")),
    }
}

fn sprint_create(
    state: &AppState,
    store: &mut PmStore,
    params: &Value,
) -> Result<Value, ControlError> {
    let parsed: PmSprintCreateParams = parse(params)?;
    require_project(store, &parsed.project_id)?;
    let sprint_state = match parsed.state.as_deref() {
        None => Default::default(),
        Some(name) => enum_value(name, "state")?,
    };
    let mut sprint = store.create_sprint(
        &parsed.project_id,
        &parsed.name,
        parsed.goal.as_deref(),
        sprint_state,
    )?;
    if let Some(ends_at) = parsed.ends_at_epoch_ms {
        sprint = store.set_sprint_end(&sprint.id, Some(ends_at))?;
    }
    state.board_changed(&sprint.project_id);
    to_value(&sprint)
}

/// Applies each present field in turn; a field sent as `null` clears it.
fn sprint_update(
    state: &AppState,
    store: &mut PmStore,
    params: &Value,
) -> Result<Value, ControlError> {
    let parsed: PmSprintUpdateParams = parse(params)?;
    let id = parsed.sprint_id.as_str();
    let mut sprint = store.sprint(id)?.ok_or_else(not_found)?;
    if let Some(name) = &parsed.name {
        sprint = store.rename_sprint(id, name)?;
    }
    if let Some(goal) = nullable_string(params, "goal") {
        sprint = store.set_sprint_goal(id, goal.as_deref())?;
    }
    if let Some(ends_at) = nullable_u64(params, "endsAtEpochMs") {
        sprint = store.set_sprint_end(id, ends_at)?;
    }
    state.board_changed(&sprint.project_id);
    to_value(&sprint)
}

fn ticket_create(
    state: &AppState,
    store: &mut PmStore,
    params: &Value,
) -> Result<Value, ControlError> {
    let parsed: PmTicketCreateParams = parse(params)?;
    require_project(store, &parsed.project_id)?;
    let mut new = NewTicket::new(parsed.project_id, parsed.title);
    new.description = parsed.description.unwrap_or_default();
    if let Some(status) = &parsed.status {
        new.status = convert(status)?;
    }
    if let Some(priority) = &parsed.priority {
        new.priority = convert(priority)?;
    }
    new.assignee = parsed.assignee;
    new.sprint_id = parsed.sprint_id;
    new.jira_url = parsed.jira_url;
    let ticket = store.create_ticket(new)?;
    published_ticket(state, &ticket)
}

/// Applies each present field in turn; `assignee` or `jiraUrl` sent as
/// `null` clears it. The steps are separate store commands.
fn ticket_update(
    state: &AppState,
    store: &mut PmStore,
    params: &Value,
) -> Result<Value, ControlError> {
    let parsed: PmTicketUpdateParams = parse(params)?;
    let id = parsed.ticket_id.as_str();
    require_ticket(store, id)?;
    let edit = TicketEdit {
        title: parsed.title.clone(),
        jira_url: nullable_string(params, "jiraUrl"),
    };
    if edit != TicketEdit::default() {
        store.update_ticket(id, edit)?;
    }
    if let Some(status) = &parsed.status {
        store.set_ticket_status(id, convert(status)?)?;
    }
    if let Some(priority) = &parsed.priority {
        store.set_ticket_priority(id, convert(priority)?)?;
    }
    if let Some(assignee) = nullable_string(params, "assignee") {
        store.set_ticket_assignee(id, assignee.as_deref())?;
    }
    changed_ticket(state, store, id)
}

/// Moves a ticket to a sprint lane (or the backlog with `null`), then to
/// `index` within that lane when given.
fn ticket_move(
    state: &AppState,
    store: &mut PmStore,
    params: &Value,
) -> Result<Value, ControlError> {
    let parsed: PmTicketMoveParams = parse(params)?;
    let id = parsed.ticket_id.as_str();
    let ticket = require_ticket(store, id)?;
    if ticket.sprint_id != parsed.sprint_id {
        store.move_ticket_to_sprint(id, parsed.sprint_id.as_deref())?;
    }
    if let Some(index) = parsed.index {
        let mut lane: Vec<String> = store
            .board(&ticket.project_id)?
            .tickets
            .into_iter()
            .filter(|candidate| candidate.sprint_id == parsed.sprint_id && candidate.id != id)
            .map(|candidate| candidate.id)
            .collect();
        lane.insert((index as usize).min(lane.len()), id.to_owned());
        store.reorder_tickets(&ticket.project_id, parsed.sprint_id.as_deref(), &lane)?;
    }
    changed_ticket(state, store, id)
}

/// The board as the contract shapes it: each ticket beside its delivery and
/// pending proposal count, and the running checks with their agent session.
pub(crate) fn board(
    state: &AppState,
    store: &PmStore,
    project_id: &str,
) -> Result<Value, ControlError> {
    let board = store.board(project_id)?;
    let tickets = board
        .tickets
        .iter()
        .zip(&board.deliveries)
        .map(|(ticket, delivery)| {
            Ok(json!({
                "ticket": to_value(ticket)?,
                "delivery": to_value(delivery)?,
                "pendingProposalCount": store.ticket_proposals(&ticket.id)?.len(),
            }))
        })
        .collect::<Result<Vec<_>, ControlError>>()?;
    let running = store
        .delivery_checks(project_id)?
        .into_iter()
        .filter(DeliveryCheck::is_running)
        .map(|check| check_value(state, &check))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "projectId": board.project_id,
        "sprints": to_value(&board.sprints)?,
        "tickets": tickets,
        "playbook": to_value(&board.playbook)?,
        "runningChecks": running,
        "tracking": to_value(&board.tracking)?,
    }))
}

/// A check with the agent session running it, when one does.
pub(crate) fn check_value(state: &AppState, check: &DeliveryCheck) -> Result<Value, ControlError> {
    let mut value = to_value(check)?;
    let session = state.agents.check_session(&check.id);
    if let Value::Object(fields) = &mut value {
        fields.insert(
            "sessionId".to_owned(),
            session.map_or(Value::Null, Value::String),
        );
    }
    Ok(value)
}

fn sources(project_id: &str, sources: &ProjectSources) -> Result<Value, ControlError> {
    Ok(json!({
        "projectId": project_id,
        "jira": to_value(&sources.jira)?,
        "github": to_value(&sources.github)?,
        "azureDevOps": to_value(&sources.azure_devops)?,
    }))
}

fn changed_ticket(
    state: &AppState,
    store: &PmStore,
    ticket_id: &str,
) -> Result<Value, ControlError> {
    published_ticket(state, &require_ticket(store, ticket_id)?)
}

fn published_ticket(state: &AppState, ticket: &Ticket) -> Result<Value, ControlError> {
    state.board_changed(&ticket.project_id);
    to_value(ticket)
}

pub(crate) fn require_project(
    store: &PmStore,
    project_id: &str,
) -> Result<termloop_pm::Project, ControlError> {
    store.project(project_id)?.ok_or_else(not_found)
}

pub(crate) fn require_ticket(store: &PmStore, ticket_id: &str) -> Result<Ticket, ControlError> {
    store.ticket(ticket_id)?.ok_or_else(not_found)
}

pub(crate) fn parse<T: DeserializeOwned>(params: &Value) -> Result<T, ControlError> {
    serde_json::from_value(params.clone())
        .map_err(|_| error(ErrorCode::InvalidParams, "params do not match the method"))
}

pub(crate) fn to_value<T: Serialize + ?Sized>(value: &T) -> Result<Value, ControlError> {
    serde_json::to_value(value).map_err(|_| internal())
}

/// A contract value as the PM store's own type; both share wire names.
pub(crate) fn convert<A: Serialize, B: DeserializeOwned>(value: &A) -> Result<B, ControlError> {
    serde_json::from_value(to_value(value)?).map_err(|_| internal())
}

fn enum_value<T: DeserializeOwned>(name: &str, parameter: &str) -> Result<T, ControlError> {
    serde_json::from_value(Value::String(name.to_owned()))
        .map_err(|_| super::errors::invalid_parameter(parameter))
}

/// A nullable field as sent: absent is `None`, `null` is `Some(None)`.
pub(crate) fn nullable_string(params: &Value, name: &str) -> Option<Option<String>> {
    let fields: &Map<String, Value> = params.as_object()?;
    fields
        .get(name)
        .map(|value| value.as_str().map(str::to_owned))
}

fn nullable_u64(params: &Value, name: &str) -> Option<Option<u64>> {
    params.as_object()?.get(name).map(Value::as_u64)
}
