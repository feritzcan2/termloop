//! The bug owner finder's evidence read: gathers who touched what the
//! ticket names (git history in the project's code folder, GitHub pull
//! request authors and reviewers, assignees of similar past tickets) and
//! ranks it. Read-only; the store lock is never held across git or GitHub.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use termloop_gitio::GitRunner;
use termloop_pm::agent::PmToolError;
use termloop_pm::skill::{
    OwnerSignal, OwnerSignalKind, OwnerSourceRead, owner_limitation, rank_owners, similar_tickets,
    ticket_paths,
};
use termloop_pm::{PmError, Ticket};
use termloop_providers::{
    GitHubClient, GitHubRepository, MAX_PULL_REQUEST_PEOPLE, parse_github_remote,
};

use crate::app::AppState;
use crate::app::code_host::REMOTES_TIMEOUT;

const GITHUB_TIMEOUT: Duration = Duration::from_secs(15);
/// Similar tickets whose key is looked up in commit messages.
const SIMILAR_KEYS_MAX: usize = 4;

pub(crate) async fn owner_evidence(
    state: &AppState,
    project_id: &str,
    ticket_id: &str,
) -> Result<Value, PmToolError> {
    let (folder, repository, ticket, paths, similar, pull_requests) = {
        let store = state.store.lock();
        let ticket = store
            .ticket(ticket_id)?
            .filter(|ticket| ticket.project_id == project_id)
            .ok_or(PmError::NotFound)?;
        let project = store.project(project_id)?.ok_or(PmError::NotFound)?;
        let github = store.project_sources(project_id)?.github;
        let tickets = store.project_tickets(project_id)?;
        let paths = ticket_paths(&ticket);
        let similar: Vec<Ticket> = similar_tickets(&ticket, &paths, &tickets)
            .into_iter()
            .cloned()
            .collect();
        let mut pull_requests: Vec<u64> = Vec::new();
        if let Some(source) = &github {
            for id in std::iter::once(&ticket.id).chain(similar.iter().map(|other| &other.id)) {
                let fact = store
                    .ticket_facts(id)?
                    .and_then(|facts| facts.pull_requests);
                for item in fact
                    .filter(|fact| fact.repository == source.label())
                    .into_iter()
                    .flat_map(|fact| fact.items)
                {
                    if !pull_requests.contains(&item.number) {
                        pull_requests.push(item.number);
                    }
                }
            }
        }
        pull_requests.truncate(MAX_PULL_REQUEST_PEOPLE);
        let repository = github.map(|source| GitHubRepository {
            owner: source.owner,
            name: source.name,
        });
        (
            project.folder.map(PathBuf::from),
            repository,
            ticket,
            paths,
            similar,
            pull_requests,
        )
    };
    let keys: Vec<String> = similar
        .iter()
        .filter_map(Ticket::jira_issue_key)
        .take(SIMILAR_KEYS_MAX)
        .collect();
    let provider_directory = state.provider_directory.clone();
    let read = (folder.clone(), repository.clone(), paths.clone());
    let (git, github) = tokio::task::spawn_blocking(move || {
        let (folder, repository, paths) = read;
        std::thread::scope(|scope| {
            let github = scope.spawn(|| {
                repository
                    .as_ref()
                    .map(|repository| pull_signals(repository, &pull_requests, &provider_directory))
            });
            let git = folder
                .as_deref()
                .map(|folder| git_signals(folder, &paths, &keys, repository.as_ref()));
            (git, github.join().unwrap_or(Some(Err(()))))
        })
    })
    .await
    .map_err(|_| PmError::Storage("the owner read did not finish".to_owned()))?;
    let source_read = |read: &Option<Result<Vec<OwnerSignal>, ()>>| match read {
        None => OwnerSourceRead::NotSet,
        Some(Ok(_)) => OwnerSourceRead::Read,
        Some(Err(())) => OwnerSourceRead::Failed,
    };
    let limitation = owner_limitation(source_read(&git), source_read(&github));
    let signals: Vec<OwnerSignal> = [git, github]
        .into_iter()
        .flat_map(|read| read.and_then(Result::ok).unwrap_or_default())
        .chain(similar.iter().filter_map(OwnerSignal::past_assignee))
        .collect();
    Ok(json!({
        "ticketId": ticket.id,
        "candidates": rank_owners(&signals, termloop_platform::current_epoch_ms()),
        "namedPaths": paths,
        "similarTickets": similar.iter().map(|other| json!({
            "ticketId": other.id,
            "title": other.title,
            "assignee": other.assignee,
        })).collect::<Vec<_>>(),
        "limitation": limitation,
    }))
}

/// Commits to the named paths and commits naming similar tickets' keys.
/// Commits link to GitHub only when the folder's remote is that repository.
fn git_signals(
    folder: &Path,
    paths: &[String],
    keys: &[String],
    repository: Option<&GitHubRepository>,
) -> Result<Vec<OwnerSignal>, ()> {
    let git = GitRunner::discover().map_err(|_| ())?;
    let linked = repository.filter(|repository| {
        git.observe_remotes_with_timeout(folder, REMOTES_TIMEOUT)
            .is_ok_and(|remotes| {
                remotes
                    .iter()
                    .flat_map(|remote| &remote.fetch_urls)
                    .any(|url| {
                        parse_github_remote(url).is_ok_and(|found| found.same_as(repository))
                    })
            })
    });
    let reads = paths
        .iter()
        .map(|path| (path.as_str(), git.path_history(folder, path.as_bytes())))
        .chain(
            keys.iter()
                .map(|key| (key.as_str(), git.message_history(folder, key))),
        );
    let mut signals = Vec::new();
    for (subject, read) in reads {
        for commit in read.map_err(|_| ())?.commits {
            let oid = commit.oid().as_hex();
            let label = format!(
                "{subject}: commit {} · {}",
                &oid[..oid.len().min(10)],
                String::from_utf8_lossy(commit.subject())
            );
            signals.extend(OwnerSignal::new(
                &String::from_utf8_lossy(commit.author()),
                OwnerSignalKind::Commit,
                &label,
                linked.map(|repository| repository.commit_url(oid)),
                commit.authored_at_epoch_ms(),
            ));
        }
    }
    Ok(signals)
}

/// Authors and reviewers of the related pull requests.
fn pull_signals(
    repository: &GitHubRepository,
    pull_requests: &[u64],
    provider_directory: &Path,
) -> Result<Vec<OwnerSignal>, ()> {
    let people = GitHubClient::new(provider_directory)
        .pull_request_people(repository, pull_requests, GITHUB_TIMEOUT)
        .map_err(|_| ())?;
    let mut signals = Vec::new();
    for pull in &people {
        let roles = pull
            .author
            .iter()
            .map(|author| (author, OwnerSignalKind::PullRequestAuthor, "Wrote"))
            .chain(
                pull.reviewers
                    .iter()
                    .map(|reviewer| (reviewer, OwnerSignalKind::PullRequestReviewer, "Reviewed")),
            );
        for (login, kind, verb) in roles {
            signals.extend(OwnerSignal::new(
                login,
                kind,
                &format!("{verb} pull request #{}", pull.number),
                Some(pull.url.clone()),
                pull.created_at_epoch_ms,
            ));
        }
    }
    Ok(signals)
}
