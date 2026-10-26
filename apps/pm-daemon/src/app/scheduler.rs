//! The PM daemon's schedules: each check tick abandons overdue delivery
//! checks, runs due probes, starts the checks that are due, and runs due
//! skills; the fact refresh reads Jira, follows each project folder's code
//! host, and reads its pull requests for the active sprint's tickets every
//! ten minutes and after each Jira pull.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use termloop_platform::{CommandRequest, CommandTermination};
use termloop_pm::skill::SkillEvent;
use termloop_pm::{
    CommitAncestryFact, DeliveryCheck, DeliveryProbe, FactRead, FactsObservation, NewCheck,
    PmError, ProbeMatcher, ProbeOutcome, ProbeStatus, PullRequestFact, PullRequestsObservation,
    SprintState, named_commit, read_jira_sprints,
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
/// An approved probe runs again once its last run is this old.
const PROBE_INTERVAL_MS: u64 = 10 * 60 * 1000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;
/// Tickets whose pull requests one refresh reads per project.
const PULL_REQUEST_TICKETS_MAX: usize = 50;

/// Starts the agent of a started check and returns its session id.
pub(crate) type CheckLaunch = fn(&AppState, &DeliveryCheck) -> Result<String, ControlError>;

/// Why a check was not started, as the contract names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    NotFound,
    DeployTrackingOff,
    AlreadyRunning,
    ProjectLimitReached,
    AgentUnavailable,
}

impl Refusal {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "notFound",
            Self::DeployTrackingOff => "deployTrackingOff",
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
            PmError::Constraint(_) | PmError::Invalid(_) => Self::DeployTrackingOff,
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
    new: NewCheck,
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

/// One check tick: abandon overdue checks (stopping their agents), run due
/// probes, start each due check of a project whose Deployment control is
/// on, then run the skills that are due.
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
    run_due_probes(state).await;
    let projects = state.store.lock().projects().unwrap_or_default();
    for project in projects {
        let enabled = state
            .store
            .lock()
            .deployment_control_enabled(&project.id)
            .unwrap_or(false);
        if enabled {
            start_due_checks(state, &project.id, launch);
        }
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
        match start_check(state, project_id, check.into(), launch) {
            Ok(_) => started += 1,
            Err(reason) => {
                tracing::debug!(%ticket_id, reason = reason.as_str(), "a due check did not start");
            }
        }
    }
    started
}

fn probe_due(probe: &DeliveryProbe, now: u64) -> bool {
    probe.status == ProbeStatus::Approved
        && probe
            .last_run
            .as_ref()
            .is_none_or(|run| run.at_epoch_ms.saturating_add(PROBE_INTERVAL_MS) <= now)
}

async fn run_due_probes(state: &AppState) {
    let now = termloop_platform::current_epoch_ms();
    let due: Vec<(Option<String>, DeliveryProbe)> = {
        let store = state.store.lock();
        store
            .projects()
            .unwrap_or_default()
            .into_iter()
            .flat_map(|project| {
                store
                    .project_probes(&project.id)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|probe| probe_due(probe, now))
                    .map(move |probe| (project.folder.clone(), probe))
            })
            .collect()
    };
    for (folder, probe) in due {
        let folder = folder.map(PathBuf::from);
        let argv = probe.argv.clone();
        let run_folder = folder.clone();
        let Ok(outcome) =
            tokio::task::spawn_blocking(move || run_probe(&argv, run_folder.as_deref())).await
        else {
            continue;
        };
        let ancestry = match (&outcome, probe.matcher, folder) {
            (
                ProbeOutcome::Output {
                    deployed_commit: Some(deployed),
                    ..
                },
                ProbeMatcher::CommitAncestry,
                Some(folder),
            ) => {
                let targets = state
                    .store
                    .lock()
                    .commit_ancestry_targets(&probe.project_id)
                    .unwrap_or_default();
                let deployed = deployed.clone();
                tokio::task::spawn_blocking(move || ancestry_facts(&folder, &deployed, targets))
                    .await
                    .unwrap_or_default()
            }
            _ => Vec::new(),
        };
        let recorded =
            state
                .store
                .lock()
                .record_probe_run(&probe.id, &probe.argv, &outcome, &ancestry);
        match recorded {
            Ok(_) => {
                state.board_changed(&probe.project_id);
                skills::note_event(state, &probe.project_id, SkillEvent::DeployChanged);
            }
            Err(error) => tracing::debug!(%error, "a probe run was not recorded"),
        }
    }
}

/// Runs one probe without a shell in the project folder. Its output is kept
/// only as a hash and the commit it names.
fn run_probe(argv: &[String], folder: Option<&Path>) -> ProbeOutcome {
    let (Some(program), Some(folder)) = (argv.first(), folder) else {
        return ProbeOutcome::Failed("noFolder".to_owned());
    };
    let request = CommandRequest::new(program)
        .args(&argv[1..])
        .cwd(folder)
        .timeout(PROBE_TIMEOUT)
        .output_limit(PROBE_OUTPUT_LIMIT);
    match termloop_platform::run_command(request) {
        Err(_) => ProbeOutcome::Failed("notFound".to_owned()),
        Ok(outcome) => match outcome.termination {
            CommandTermination::Exited { code: 0 } => {
                let output = String::from_utf8_lossy(&outcome.stdout);
                ProbeOutcome::Output {
                    output_hash: Sha256::digest(&outcome.stdout)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                    deployed_commit: named_commit(&output),
                }
            }
            CommandTermination::Exited { .. } => ProbeOutcome::Failed("exitStatus".to_owned()),
            CommandTermination::Signaled { .. } => ProbeOutcome::Failed("signaled".to_owned()),
            CommandTermination::TimedOut => ProbeOutcome::Failed("timedOut".to_owned()),
        },
    }
}

/// Asks Git whether each ticket's merge commit is in the deployed commit.
fn ancestry_facts(
    folder: &Path,
    deployed: &str,
    targets: Vec<(String, String)>,
) -> Vec<CommitAncestryFact> {
    let Ok(git) = termloop_gitio::GitRunner::discover() else {
        return Vec::new();
    };
    targets
        .into_iter()
        .map(|(ticket_id, merge_commit)| CommitAncestryFact {
            ticket_id,
            contained: git
                .commit_contains(folder, deployed, &merge_commit)
                .ok()
                .flatten(),
        })
        .collect()
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
