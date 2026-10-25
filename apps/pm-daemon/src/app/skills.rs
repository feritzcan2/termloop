//! Skills in the daemon: the skill creator, runs and dry runs of installed
//! skills, the deterministic prefilter that decides before any launch
//! whether a run has anything new, the built-in Deployment control, and
//! the host tools the creator calls.
//!
//! A run's agent sees only its approved read tools and the proposal tools;
//! everything it suggests is a draft for the PM.

use std::time::Duration;

use serde_json::{Value, json};
use termloop_pm::agent::{
    PM_SKILL_DISCOVERY_READ, PM_SKILL_DRY_RUN_REQUEST, PM_SKILL_TOOL_VERIFY, PmAgentMode,
    PmAgentProfile, PmToolContext, PmToolError, SkillRunBrief, SkillRunContext,
};
use termloop_pm::skill::{
    BuiltinSkill, SKILL_DRY_RUN_WINDOW_MS, SkillManifest, SkillPrefilter, SkillRun,
    SkillRunTrigger, SkillSource,
};
use termloop_pm::{PmError, PmStore, Ticket};
use termloop_pm_contract::pm::EventName;

use crate::app::control::errors::{ControlError, not_found};
use crate::app::control::to_value;
use crate::app::{AppState, agents, scheduler, skill_discovery};

/// A skill's first run reads this far back.
const FIRST_RUN_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
/// Tickets one run is pointed at.
const RUN_TICKETS_MAX: usize = 50;
/// How long a finished run's agent may still write its last words.
const STOP_AFTER_FINISH: Duration = Duration::from_secs(5);
/// Words that make a ticket read like a bug.
const BUG_WORDS: &[&str] = &[
    "bug",
    "crash",
    "error",
    "exception",
    "broken",
    "fails",
    "failing",
    "failure",
    "regression",
    "defect",
    "incident",
];

pub(crate) fn publish(state: &AppState, project_id: &str) {
    state.publish(
        EventName::PmSkillsChanged,
        json!({ "projectId": project_id }),
    );
}

/// The project's skills (the built-in ones it qualifies for included) and
/// the drafts waiting for review.
pub(crate) fn skills_value(store: &mut PmStore, project_id: &str) -> Result<Value, ControlError> {
    store.ensure_builtin_skills(project_id)?;
    Ok(json!({
        "projectId": project_id,
        "skills": to_value(&store.skills(project_id)?)?,
        "drafts": to_value(&store.skill_drafts(project_id)?)?,
    }))
}

pub(crate) fn bug_like(ticket: &Ticket) -> bool {
    let text = format!("{} {}", ticket.title, ticket.description).to_lowercase();
    text.split(|character: char| !character.is_alphanumeric())
        .any(|word| BUG_WORDS.contains(&word))
}

/// What a prefilter kept for one run.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Kept {
    pub(crate) ticket_ids: Vec<String>,
    pub(crate) note: Option<String>,
}

/// The deterministic check before any launch: the tickets (or messages)
/// new since `since`. Nothing kept means no agent starts.
pub(crate) fn prefilter(
    store: &PmStore,
    project_id: &str,
    manifest: &SkillManifest,
    since: u64,
) -> Result<Kept, PmError> {
    let mut tickets: Vec<Ticket> = store
        .board(project_id)?
        .tickets
        .into_iter()
        .filter(|ticket| ticket.updated_at_epoch_ms >= since)
        .collect();
    tickets.sort_by(|a, b| b.updated_at_epoch_ms.cmp(&a.updated_at_epoch_ms));
    let keep = |ticket: &Ticket| match manifest.prefilter {
        SkillPrefilter::BoardChanges => true,
        SkillPrefilter::BugTickets => bug_like(ticket),
        // Slack reads come with the Slack tracker; delivery checks are
        // the built-in skill's.
        SkillPrefilter::SlackMentions | SkillPrefilter::DeliveryChecks => false,
    };
    Ok(Kept {
        ticket_ids: tickets
            .iter()
            .filter(|ticket| keep(ticket))
            .take(RUN_TICKETS_MAX)
            .map(|ticket| ticket.id.clone())
            .collect(),
        note: None,
    })
}

/// Launches the agent of a recorded run. A run whose agent does not start
/// is closed as failed.
fn launch_run(
    state: &AppState,
    project_id: &str,
    manifest: &SkillManifest,
    run: &SkillRun,
    kept: Kept,
) -> Result<(), ControlError> {
    let context = SkillRunContext {
        run_id: run.id.clone(),
        skill: run.skill_id.clone().zip(run.version),
        draft_id: run.draft_id.clone(),
        approved_tools: manifest.approved_tools.clone(),
    };
    let tools = PmToolContext {
        skill: Some(context.clone()),
        ..PmToolContext::new(project_id, PmAgentMode::SkillRun)
    }
    .tools();
    let brief = SkillRunBrief {
        name: manifest.name.clone(),
        description: manifest.description.clone(),
        instructions: manifest.instructions.clone(),
        tools,
        ticket_ids: kept.ticket_ids,
        items_note: kept.note,
        dry_run: run.draft_id.is_some(),
    };
    let launched = PmAgentProfile::build_skill_run(&state.store.lock(), project_id, &brief)
        .map_err(ControlError::from)
        .and_then(|profile| {
            agents::launch_profile(state, project_id, &profile, None, None, Some(context))
        });
    if let Err(error) = launched {
        let _ = state.store.lock().finish_skill_run(
            &run.id,
            termloop_pm::skill::SkillRunOutcome::Failed,
            Some("The agent did not start."),
        );
        publish(state, project_id);
        return Err(error);
    }
    Ok(())
}

/// Runs a skill now. The built-in Deployment control starts the delivery
/// checks that are due; any other skill runs its prefilter and launches an
/// agent only when it kept something.
pub(crate) fn run(
    state: &AppState,
    skill_id: &str,
    trigger: SkillRunTrigger,
) -> Result<Value, ControlError> {
    let skill = state.store.lock().skill(skill_id)?.ok_or_else(not_found)?;
    if skill.builtin == Some(BuiltinSkill::DeploymentControl) {
        let started = scheduler::start_due_checks(state, &skill.project_id, agents::launch_check);
        let skill = state.store.lock().skill(skill_id)?.ok_or_else(not_found)?;
        publish(state, &skill.project_id);
        return Ok(json!({ "skill": to_value(&skill)?, "run": null, "checksStarted": started }));
    }
    let now = termloop_platform::current_epoch_ms();
    let (run, kept) = {
        let mut store = state.store.lock();
        let since = store
            .skill_watermark(skill_id)?
            .unwrap_or_else(|| now.saturating_sub(FIRST_RUN_WINDOW_MS));
        let kept = prefilter(&store, &skill.project_id, &skill.manifest, since)?;
        if kept.ticket_ids.is_empty() {
            (store.record_skipped_skill_run(skill_id, trigger)?, None)
        } else {
            let items = u32::try_from(kept.ticket_ids.len()).unwrap_or(u32::MAX);
            (store.start_skill_run(skill_id, trigger, items)?, Some(kept))
        }
    };
    let launched = match kept {
        Some(kept) => launch_run(state, &skill.project_id, &skill.manifest, &run, kept),
        None => Ok(()),
    };
    publish(state, &skill.project_id);
    launched?;
    let store = state.store.lock();
    Ok(json!({
        "skill": to_value(&store.skill(skill_id)?.ok_or_else(not_found)?)?,
        "run": to_value(&store.skill_run(&run.id)?.ok_or_else(not_found)?)?,
        "checksStarted": 0,
    }))
}

/// Starts a draft's dry run over the last 3 days; its suggestions become
/// samples on the draft.
pub(crate) fn dry_run(state: &AppState, draft_id: &str) -> Result<SkillRun, ControlError> {
    let now = termloop_platform::current_epoch_ms();
    let (draft, run, kept) = {
        let mut store = state.store.lock();
        let draft = store.skill_draft(draft_id)?.ok_or_else(not_found)?;
        let since = now.saturating_sub(SKILL_DRY_RUN_WINDOW_MS);
        let kept = prefilter(&store, &draft.project_id, &draft.manifest, since)?;
        let items = u32::try_from(kept.ticket_ids.len()).unwrap_or(u32::MAX);
        let run = store.start_dry_run(draft_id, items)?;
        (draft, run, kept)
    };
    launch_run(state, &draft.project_id, &draft.manifest, &run, kept)?;
    publish(state, &draft.project_id);
    Ok(run)
}

/// Launches the skill creator for the project in the Assistant pane.
pub(crate) fn launch_creator(
    state: &AppState,
    project_id: &str,
) -> Result<agents::AgentRecord, ControlError> {
    agents::launch(state, project_id, PmAgentMode::SkillCreator, None, None)
}

/// A skill-run agent exited: a run it did not finish failed.
pub(crate) fn on_run_exit(state: &AppState, project_id: &str, run_id: &str) {
    let finished = state.store.lock().finish_skill_run(
        run_id,
        termloop_pm::skill::SkillRunOutcome::Failed,
        Some("The agent stopped before it reported."),
    );
    if finished.is_ok() {
        publish(state, project_id);
    }
}

/// A run reported: its agent is stopped shortly after, so an unattended
/// provider session never lingers.
pub(crate) fn stop_after_finish(state: &AppState, run_id: &str) {
    let Some(session) = state.agents.skill_run_session(run_id) else {
        return;
    };
    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(STOP_AFTER_FINISH).await;
        let _ = agents::stop(&state, &session);
    });
}

/// One skill tick: abandon overdue runs (stopping their agents), then run
/// each skill due by event or schedule.
pub(crate) fn skill_tick(state: &AppState) {
    let now = termloop_platform::current_epoch_ms();
    let abandoned = state.store.lock().abandon_stale_skill_runs(now);
    for run in abandoned.unwrap_or_default() {
        if let Some(session) = state.agents.skill_run_session(&run.id) {
            let _ = agents::stop(state, &session);
        }
        publish(state, &run.project_id);
    }
    let projects = state.store.lock().projects().unwrap_or_default();
    for project in projects {
        let due = state
            .store
            .lock()
            .due_skills(&project.id, now)
            .unwrap_or_default();
        for (skill_id, trigger) in due {
            if let Err(error) = run(state, &skill_id, trigger) {
                tracing::debug!(%skill_id, code = ?error.0.code, "a due skill did not run");
            }
        }
    }
}

/// Notes a daemon event for the project's skills waiting for it.
pub(crate) fn note_event(
    state: &AppState,
    project_id: &str,
    event: termloop_pm::skill::SkillEvent,
) {
    if let Ok(noted) = state.store.lock().note_skill_event(project_id, event)
        && noted > 0
    {
        publish(state, project_id);
    }
}

fn host_error(error: PmError) -> PmToolError {
    PmToolError::Store(error)
}

fn denied(tool: &str, reason: &'static str) -> PmToolError {
    PmToolError::Denied {
        tool: tool.to_owned(),
        reason,
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DiscoveryParams {
    #[serde(default)]
    refresh: bool,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyParams {
    kind: String,
    name: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DryRunParams {
    draft_id: String,
}

fn parse<T: serde::de::DeserializeOwned>(arguments: Value) -> Result<T, PmToolError> {
    let arguments = if arguments.is_null() {
        json!({})
    } else {
        arguments
    };
    serde_json::from_value(arguments)
        .map_err(|error| PmToolError::InvalidArguments(error.to_string()))
}

/// Answers a host tool the caller's context allows (checked by the
/// caller with `pm_tool_access`).
pub(crate) async fn host_tool(
    state: &AppState,
    context: &PmToolContext,
    tool: &'static str,
    arguments: Value,
) -> Result<Value, PmToolError> {
    match tool {
        PM_SKILL_DISCOVERY_READ => {
            let params: DiscoveryParams = parse(arguments)?;
            skill_discovery::discovery(state, &context.project_id, params.refresh)
                .await
                .map_err(host_error)
        }
        PM_SKILL_TOOL_VERIFY => {
            let params: VerifyParams = parse(arguments)?;
            verify(state, &context.project_id, &params.kind, &params.name).await
        }
        PM_SKILL_DRY_RUN_REQUEST => {
            let params: DryRunParams = parse(arguments)?;
            let owned = state
                .store
                .lock()
                .skill_draft(&params.draft_id)
                .map_err(host_error)?
                .is_some_and(|draft| draft.project_id == context.project_id);
            if !owned {
                return Err(host_error(PmError::NotFound));
            }
            let run = dry_run(state, &params.draft_id).map_err(|error| {
                PmToolError::InvalidArguments(error.0.message.chars().take(200).collect())
            })?;
            Ok(json!({ "runId": run.id, "draftId": params.draft_id, "state": "running" }))
        }
        _ => Err(PmToolError::UnknownTool(tool.to_owned())),
    }
}

fn verified(kind: &str, name: &str, works: bool, detail: &str) -> Value {
    json!({ "kind": kind, "name": name, "works": works, "detail": detail })
}

/// Checks one discovered tool with a harmless read-only call. A CLI off
/// the allowlist is refused without running anything.
pub(crate) async fn verify(
    state: &AppState,
    project_id: &str,
    kind: &str,
    name: &str,
) -> Result<Value, PmToolError> {
    match kind {
        "cli" => {
            let owned = name.to_owned();
            let status = tokio::task::spawn_blocking(move || skill_discovery::cli_status(&owned))
                .await
                .map_err(|_| host_error(PmError::Storage("the check did not finish".to_owned())))?
                .ok_or_else(|| {
                    denied(PM_SKILL_TOOL_VERIFY, "the CLI is not on the PM's allowlist")
                })?;
            let works = status["installed"] == true && status["loggedIn"] == true;
            Ok(verified(
                kind,
                name,
                works,
                if works {
                    "installed and logged in"
                } else if status["installed"] == true {
                    "installed but not logged in"
                } else {
                    "not installed"
                },
            ))
        }
        "mcp" => {
            if !skill_discovery::configured_server(state, project_id, name) {
                return Err(host_error(PmError::NotFound));
            }
            Ok(verified(
                kind,
                name,
                false,
                "configured for Claude or Codex; a skill run cannot call it and reads through \
                 the PM's own tools instead",
            ))
        }
        "source" => verify_source(state, project_id, name).await,
        _ => Err(PmToolError::InvalidArguments("unknown kind".to_owned())),
    }
}

async fn verify_source(
    state: &AppState,
    project_id: &str,
    name: &str,
) -> Result<Value, PmToolError> {
    let source: SkillSource = serde_json::from_value(Value::from(name))
        .map_err(|_| PmToolError::InvalidArguments("unknown source".to_owned()))?;
    let (works, detail) = match source {
        SkillSource::Board => (true, "the PM board is always readable"),
        SkillSource::Deployments => {
            let board = state.store.lock().board(project_id).map_err(host_error)?;
            if board.environments.is_empty() {
                (false, "no environments are listed in Settings")
            } else {
                (true, "environments are listed")
            }
        }
        SkillSource::Jira => crate::app::jira::verify(state, project_id).await,
        SkillSource::Git => {
            let folder = state
                .store
                .lock()
                .project(project_id)
                .map_err(host_error)?
                .and_then(|project| project.folder);
            match folder {
                Some(_) => (true, "the project has a checkout folder"),
                None => (false, "no checkout folder is set for the project"),
            }
        }
        SkillSource::GitHub => {
            let configured = state
                .store
                .lock()
                .project_sources(project_id)
                .map_err(host_error)?
                .github
                .is_some();
            let logged_in = tokio::task::spawn_blocking(|| skill_discovery::cli_status("gh"))
                .await
                .ok()
                .flatten()
                .is_some_and(|status| status["loggedIn"] == true);
            match (configured, logged_in) {
                (false, _) => (false, "no GitHub repository is set in Settings"),
                (true, false) => (false, "the GitHub CLI is not logged in"),
                (true, true) => (
                    true,
                    "the repository is set and the GitHub CLI is logged in",
                ),
            }
        }
        SkillSource::Slack => (false, "Slack is not connected"),
    };
    Ok(verified("source", name, works, detail))
}
