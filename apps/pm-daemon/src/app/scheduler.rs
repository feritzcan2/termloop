//! The PM daemon's schedules: each check tick abandons overdue delivery
//! checks, starts the Playbook checks that are due, and runs due skills; the fact refresh reads Jira, follows each project folder's code
//! host, and reads its pull requests for the active sprint's tickets every
//! ten minutes and after each Jira pull.

use std::time::Duration;

use termloop_pm::{
    DeliveryCheck, DueCheck, FactRead, FactsObservation, PmError, PullRequestFact,
    PullRequestsObservation, SprintState, read_jira_sprints,
};
use termloop_providers::{JiraCloudClient, JiraCredential, ProviderFailure};

use crate::app::code_host::{self, CodeHost};
use crate::app::control::errors::ControlError;
use crate::app::{AppState, agents, credentials, jira, skills};

const CHECK_TICK: Duration = Duration::from_secs(60);
/// Expired skill data is dropped once every this many ticks; it expires
/// by the day, so an hourly sweep is enough.
const EXPIRY_TICKS: u32 = 60;
const FACT_REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// Tickets whose pull requests one refresh reads per project.
const PULL_REQUEST_TICKETS_MAX: usize = 50;

/// Starts the agent of a started check and returns its session id.
pub(crate) type CheckLaunch = fn(&AppState, &DeliveryCheck) -> Result<String, ControlError>;

/// Why a check was not started, as the contract names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    NotFound,
    NoAgentStep,
    AlreadyRunning,
    ProjectLimitReached,
    AgentUnavailable,
}

impl Refusal {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "notFound",
            Self::NoAgentStep => "noAgentStep",
            Self::AlreadyRunning => "alreadyRunning",
            Self::ProjectLimitReached => "projectLimitReached",
            Self::AgentUnavailable => "agentUnavailable",
        }
    }

    fn from_store(error: &PmError) -> Self {
        match error {
            PmError::Constraint("a check is already running for the ticket") => {
                Self::AlreadyRunning
            }
            PmError::Constraint("too many running checks") => Self::ProjectLimitReached,
            PmError::Constraint(_) | PmError::Invalid(_) => Self::NoAgentStep,
            PmError::NotFound => Self::NotFound,
            _ => {
                tracing::warn!(%error, "a delivery check could not be recorded");
                Self::AgentUnavailable
            }
        }
    }
}

/// Records a check for a ticket of the project and launches its agent. A
/// check whose agent does not start is closed as failed at once.
pub(crate) fn start_check(
    state: &AppState,
    project_id: &str,
    new: DueCheck,
    launch: CheckLaunch,
) -> Result<DeliveryCheck, Refusal> {
    let check = {
        let mut store = state.store.lock();
        match store.ticket(&new.ticket_id) {
            Ok(Some(ticket)) if ticket.project_id == project_id => {}
            _ => return Err(Refusal::NotFound),
        }
        store
            .start_check(new)
            .map_err(|error| Refusal::from_store(&error))?
    };
    match launch(state, &check) {
        Ok(_) => {
            agents::publish_check(state, &check);
            Ok(check)
        }
        Err(_) => {
            if let Ok(failed) = state
                .store
                .lock()
                .finish_check(&check.id, termloop_pm::DeliveryCheckOutcome::Failed)
            {
                agents::publish_check(state, &failed);
            }
            Err(Refusal::AgentUnavailable)
        }
    }
}

pub(crate) async fn run_check_scheduler(state: AppState) {
    let mut interval = tokio::time::interval(CHECK_TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ticks = 0;
    loop {
        interval.tick().await;
        if ticks % EXPIRY_TICKS == 0 {
            skills::expire_skill_data(&state);
        }
        ticks = ticks.wrapping_add(1);
        check_tick(&state, agents::launch_check).await;
    }
}

/// One check tick: abandon overdue checks (stopping their agents), start
/// each project's due Playbook checks, then run the skills that are due.
pub(crate) async fn check_tick(state: &AppState, launch: CheckLaunch) {
    let abandoned = state
        .store
        .lock()
        .abandon_stale_checks(termloop_platform::current_epoch_ms());
    for check in abandoned.unwrap_or_default() {
        if let Some(session) = state.agents.check_session(&check.id) {
            let _ = agents::stop(state, &session);
        }
        agents::publish_check(state, &check);
    }
    let projects = state.store.lock().projects().unwrap_or_default();
    for project in projects {
        start_due_checks(state, &project.id, launch);
    }
    skills::skill_tick(state);
}

/// Starts each check of the project that is due and returns how many
/// started. The store refuses a second running check for a ticket.
pub(crate) fn start_due_checks(state: &AppState, project_id: &str, launch: CheckLaunch) -> u32 {
    let due = state
        .store
        .lock()
        .checks_due(project_id)
        .unwrap_or_default();
    let mut started = 0;
    for check in due {
        let ticket_id = check.ticket_id.clone();
        match start_check(state, project_id, check, launch) {
            Ok(_) => started += 1,
            Err(reason) => {
                tracing::debug!(%ticket_id, reason = reason.as_str(), "a due check did not start");
            }
        }
    }
    started
}

pub(crate) async fn run_fact_scheduler(state: AppState) {
    loop {
        refresh_facts(&state).await;
        tokio::select! {
            _ = tokio::time::sleep(FACT_REFRESH_INTERVAL) => {}
            _ = state.fact_refresh.notified() => {}
        }
    }
}

fn failure_code(failure: &ProviderFailure) -> &'static str {
    match failure {
        ProviderFailure::ProviderUnavailable => "providerUnavailable",
        ProviderFailure::Unauthorized => "unauthorized",
        ProviderFailure::Offline => "offline",
        ProviderFailure::RateLimited => "rateLimited",
        ProviderFailure::Timeout => "timeout",
        ProviderFailure::OutputLimit => "outputLimit",
        ProviderFailure::MalformedResponse => "malformedResponse",
        ProviderFailure::ProviderFailure => "providerFailure",
    }
}

/// Reads the active sprint's facts for every project: Jira status from the
/// sprint's issues, and pull requests naming each ticket's issue key.
async fn refresh_facts(state: &AppState) {
    let projects = state.store.lock().projects().unwrap_or_default();
    for project in projects {
        refresh_jira_facts(state, &project.id).await;
        code_host::refresh(state, &project.id).await;
        refresh_pull_request_facts(state, &project.id).await;
    }
}

async fn refresh_jira_facts(state: &AppState, project_id: &str) {
    let Ok(Some(pull)) = state.store.lock().plan_jira_sprint_pull(project_id) else {
        return;
    };
    let Ok(token) = credentials::resolve(&*state.credentials, &pull.credential_handle) else {
        return;
    };
    let read = tokio::task::spawn_blocking(move || {
        let client = JiraCloudClient::new()?;
        let credential = JiraCredential {
            email: &pull.account_email,
            api_token: token.expose(),
        };
        read_jira_sprints(&client, &pull, credential)
    })
    .await;
    if let Ok(Ok(read)) = read
        && let Some(issues) = read.active_issues
    {
        jira::record_issue_facts(&mut state.store.lock(), project_id, &issues);
        state.board_changed(project_id);
    }
}

/// Reads one project's pull requests for its active sprint's tickets.
pub(crate) async fn refresh_pull_request_facts(state: &AppState, project_id: &str) {
    let (label, host, tickets) = {
        let store = state.store.lock();
        let Ok(sources) = store.project_sources(project_id) else {
            return;
        };
        let Some(label) = sources.code_label() else {
            return;
        };
        let Some(host) = CodeHost::of(sources) else {
            return;
        };
        let Ok(board) = store.board(project_id) else {
            return;
        };
        let Some(active) = board
            .sprints
            .iter()
            .find(|sprint| sprint.state == SprintState::Active)
        else {
            return;
        };
        let tickets: Vec<(String, String)> = board
            .tickets
            .iter()
            .filter(|ticket| ticket.sprint_id.as_deref() == Some(active.id.as_str()))
            .filter_map(|ticket| Some((ticket.id.clone(), ticket.jira_issue_key()?)))
            .take(PULL_REQUEST_TICKETS_MAX)
            .collect();
        (label, host, tickets)
    };
    if tickets.is_empty() {
        return;
    }
    let provider_directory = state.provider_directory.clone();
    let reads = tokio::task::spawn_blocking(move || {
        let (ticket_ids, keys): (Vec<_>, Vec<_>) = tickets.into_iter().unzip();
        let reads = host.pull_requests(&provider_directory, &keys);
        ticket_ids.into_iter().zip(reads).collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    let mut store = state.store.lock();
    for (ticket_id, read) in reads {
        let pull_requests = match read {
            Ok(found) => FactRead::Read(PullRequestsObservation {
                repository: label.clone(),
                items: found
                    .pull_requests
                    .iter()
                    .map(PullRequestFact::from_summary)
                    .collect(),
                truncated: found.truncated,
            }),
            Err(failure) => FactRead::Failed(failure_code(&failure).to_owned()),
        };
        let observation = FactsObservation {
            pull_requests,
            ..FactsObservation::default()
        };
        if let Err(error) = store.record_facts(&ticket_id, observation) {
            tracing::debug!(%error, "skipped a pull request fact the store refused");
        }
    }
    drop(store);
    state.board_changed(project_id);
}
