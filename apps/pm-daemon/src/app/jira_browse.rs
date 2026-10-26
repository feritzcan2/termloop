//! Jira reads for the PM's Orca-style issue browser: projects, statuses,
//! favourite filters, and issue searches, and for its sprint picker: boards
//! and a board's open sprints. They read Jira only, never write
//! the store, and use the project's Jira source and stored token exactly
//! as `pm_jira_pull` does: the token is resolved for one call on a blocking
//! task, and the store lock is never held while Jira is called.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;
use termloop_pm::{JiraSource, PmStore};
use termloop_pm_contract::pm::{
    PmJiraBoard, PmJiraBoardColumn, PmJiraBoardSprint, PmJiraBoardsReadResult, PmJiraFailure,
    PmJiraFavouriteFilter, PmJiraFavouriteFiltersReadResult, PmJiraIssue, PmJiraIssueStatus,
    PmJiraIssueUser, PmJiraProject, PmJiraProjectsReadResult, PmJiraSearchOrder,
    PmJiraSearchParams, PmJiraSearchPreset, PmJiraSearchResult, PmJiraSprintState,
    PmJiraSprintsReadResult, PmJiraStatus, PmJiraStatusCategory, PmJiraStatusesReadParams,
    PmJiraStatusesReadResult, PmProjectRef,
};
use termloop_providers::{
    JiraBoardSource, JiraCloudClient, JiraCredential, JiraIssueListing, JiraIssueOrder,
    JiraIssuePreset, JiraIssueQuery, JiraListedIssue, JiraSearchError, JiraSprintListResult,
    JiraSprintSource, JiraSprintState, JiraStatusCategory, build_jira_issue_jql,
    normalize_jira_issue_url, valid_project_key,
};

use crate::app::AppState;
use crate::app::control::errors::{
    ControlError, internal, invalid_parameter, jira_failed, not_found, search_failure,
};
use crate::app::credentials;

/// How long a site's sprint field id is reused before it is looked up again.
const SPRINT_FIELD_TTL: Duration = Duration::from_secs(10 * 60);

/// The project's Jira source; `notConfigured` when it has none.
fn jira_source(state: &AppState, project_id: &str) -> Result<JiraSource, ControlError> {
    let store = state.store.lock();
    store.project(project_id)?.ok_or_else(not_found)?;
    store
        .project_sources(project_id)?
        .jira
        .ok_or_else(|| jira_failed(PmJiraFailure::NotConfigured))
}

/// Runs one Jira read with the source's token on a blocking task.
async fn read<T: Send + 'static>(
    state: &AppState,
    source: JiraSource,
    work: impl FnOnce(&JiraCloudClient, JiraCredential<'_>, &JiraSource) -> Result<T, JiraSearchError>
    + Send
    + 'static,
) -> Result<T, ControlError> {
    let token = credentials::resolve(&*state.credentials, &source.credential_handle)
        .map_err(jira_failed)?;
    tokio::task::spawn_blocking(move || {
        let client = JiraCloudClient::new()?;
        let credential = JiraCredential {
            email: &source.account_email,
            api_token: token.expose(),
        };
        work(&client, credential, &source)
    })
    .await
    .map_err(|_| internal())?
    .map_err(|error| jira_failed(search_failure(&error)))
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, ControlError> {
    serde_json::to_value(value).map_err(|_| internal())
}

pub(crate) async fn projects_read(
    state: &AppState,
    params: PmProjectRef,
) -> Result<Value, ControlError> {
    let source = jira_source(state, &params.project_id)?;
    let list = read(state, source, |client, credential, source| {
        client.browse_projects(&source.site_url, credential)
    })
    .await?;
    to_value(&PmJiraProjectsReadResult {
        project_id: params.project_id,
        projects: list
            .projects
            .into_iter()
            .map(|project| PmJiraProject {
                key: project.key,
                name: project.name,
            })
            .collect(),
        truncated: list.truncated,
    })
}

pub(crate) async fn statuses_read(
    state: &AppState,
    params: PmJiraStatusesReadParams,
) -> Result<Value, ControlError> {
    let project_key = params.jira_project_key;
    if project_key
        .as_deref()
        .is_some_and(|key| !valid_project_key(key))
    {
        return Err(invalid_parameter("jiraProjectKey"));
    }
    let source = jira_source(state, &params.project_id)?;
    let catalog = read(state, source, move |client, credential, source| {
        client.browse_statuses(
            &source.site_url,
            credential,
            project_key.as_deref(),
            source.board_id,
        )
    })
    .await?;
    to_value(&PmJiraStatusesReadResult {
        project_id: params.project_id,
        statuses: catalog
            .statuses
            .into_iter()
            .map(|status| PmJiraStatus {
                id: status.id,
                name: status.name,
                category: category(status.category),
            })
            .collect(),
        columns: catalog
            .columns
            .into_iter()
            .map(|column| PmJiraBoardColumn {
                name: column.name,
                status_ids: column.status_ids,
            })
            .collect(),
    })
}

pub(crate) async fn favourite_filters_read(
    state: &AppState,
    params: PmProjectRef,
) -> Result<Value, ControlError> {
    let source = jira_source(state, &params.project_id)?;
    let list = read(state, source, |client, credential, source| {
        client.favourite_filters(&source.site_url, credential)
    })
    .await?;
    to_value(&PmJiraFavouriteFiltersReadResult {
        project_id: params.project_id,
        filters: list
            .filters
            .into_iter()
            .map(|filter| PmJiraFavouriteFilter {
                id: filter.id,
                name: filter.name,
                jql: filter.jql,
            })
            .collect(),
        truncated: list.truncated,
    })
}

/// The boards the account can see, to pick the one sprints come from.
pub(crate) async fn boards_read(
    state: &AppState,
    params: PmProjectRef,
) -> Result<Value, ControlError> {
    let source = jira_source(state, &params.project_id)?;
    let list = read(state, source, |client, credential, source| {
        client.list_boards(&source.site_url, credential, None)
    })
    .await?;
    let mut truncated = list.truncated;
    let boards = list
        .boards
        .into_iter()
        .filter_map(|board| {
            let id = board.id.parse().ok().filter(|id| *id > 0);
            truncated |= id.is_none();
            let id = id?;
            Some(PmJiraBoard {
                id,
                name: label(&board.name, LABEL_MAX_CHARS).unwrap_or_else(|| format!("Board {id}")),
                kind: label(&board.kind, BOARD_KIND_MAX_CHARS).unwrap_or_else(|| "board".into()),
                location: board
                    .location_name
                    .and_then(|location| label(&location, LABEL_MAX_CHARS)),
            })
        })
        .collect();
    to_value(&PmJiraBoardsReadResult {
        project_id: params.project_id,
        boards,
        truncated,
    })
}

/// The open sprints of the project's board, each with the PM sprint that
/// mirrors it.
pub(crate) async fn sprints_read(
    state: &AppState,
    params: PmProjectRef,
) -> Result<Value, ControlError> {
    let source = jira_source(state, &params.project_id)?;
    let board_id = source
        .board_id
        .ok_or_else(|| jira_failed(PmJiraFailure::NotConfigured))?;
    let list = read(state, source, move |client, credential, source| {
        client.list_sprints(&source.site_url, credential, board_id)
    })
    .await?;
    let mirrors = state.store.lock().board(&params.project_id)?.sprints;
    let (sprints, truncated, sprints_supported) = match list {
        JiraSprintListResult::Sprints { sprints, truncated } => (sprints, truncated, true),
        JiraSprintListResult::SprintsUnsupported => (Vec::new(), false, false),
    };
    let sprints = sprints
        .into_iter()
        .filter_map(|sprint| {
            let state = match sprint.state {
                JiraSprintState::Active => PmJiraSprintState::Active,
                JiraSprintState::Future => PmJiraSprintState::Future,
                JiraSprintState::Closed => return None,
            };
            let mirror = mirrors.iter().find(|mirror| {
                mirror.jira_sprint_id == Some(sprint.id) && mirror.jira_board_id == Some(board_id)
            });
            Some(PmJiraBoardSprint {
                jira_sprint_id: sprint.id,
                name: label(&sprint.name, LABEL_MAX_CHARS)
                    .unwrap_or_else(|| format!("Sprint {}", sprint.id)),
                state,
                start_epoch_ms: sprint.start_epoch_ms,
                end_epoch_ms: sprint.end_epoch_ms,
                sprint_id: mirror.map(|mirror| mirror.id.clone()),
            })
        })
        .collect();
    to_value(&PmJiraSprintsReadResult {
        project_id: params.project_id,
        board_id,
        sprints_supported,
        sprints,
        truncated,
    })
}

const LABEL_MAX_CHARS: usize = 256;
const BOARD_KIND_MAX_CHARS: usize = 64;

/// Jira text as a trimmed, bounded single-line label.
fn label(text: &str, max_chars: usize) -> Option<String> {
    let line = text
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let bounded = line.trim().chars().take(max_chars).collect::<String>();
    let bounded = bounded.trim();
    (!bounded.is_empty()).then(|| bounded.to_owned())
}

/// The provider query a search request stands for. `jql` is read only for
/// the custom preset; no project key means every project.
pub(crate) fn issue_query(params: &PmJiraSearchParams) -> JiraIssueQuery {
    let preset = match params.preset {
        PmJiraSearchPreset::Assigned => JiraIssuePreset::Assigned,
        PmJiraSearchPreset::Reported => JiraIssuePreset::Reported,
        PmJiraSearchPreset::AllOpen => JiraIssuePreset::AllOpen,
        PmJiraSearchPreset::Done => JiraIssuePreset::Done,
        PmJiraSearchPreset::Custom => JiraIssuePreset::Custom,
    };
    JiraIssueQuery {
        preset,
        custom_jql: (preset == JiraIssuePreset::Custom)
            .then(|| params.jql.clone())
            .flatten(),
        project_keys: params.jira_project_key.iter().cloned().collect(),
        statuses: params.statuses.clone().unwrap_or_default(),
        current_sprint: params.current_sprint.unwrap_or(false),
        text: params.text.clone(),
        order_by: params.order_by.as_ref().map(|order| match order {
            PmJiraSearchOrder::Updated => JiraIssueOrder::Updated,
            PmJiraSearchOrder::Created => JiraIssueOrder::Created,
            PmJiraSearchOrder::Priority => JiraIssueOrder::Priority,
        }),
    }
}

/// Searches Jira with the JQL the request stands for. An all-open search
/// over every project is bounded by the first page of the caller's projects,
/// as Jira Cloud refuses an unrestricted search.
pub(crate) async fn search(
    state: &AppState,
    params: PmJiraSearchParams,
) -> Result<Value, ControlError> {
    let mut query = issue_query(&params);
    let jql = build_jira_issue_jql(&query).map_err(|error| invalid_parameter(error.parameter()))?;
    let source = jira_source(state, &params.project_id)?;
    let bound_projects = query.preset == JiraIssuePreset::AllOpen && query.project_keys.is_empty();
    let (jql, listing) = read(state, source, move |client, credential, source| {
        let site = source.site_url.as_str();
        let mut jql = jql;
        let mut bounded_truncated = false;
        if bound_projects {
            let projects = client.browse_projects(site, credential)?;
            if projects.projects.is_empty() {
                let empty = JiraIssueListing {
                    issues: Vec::new(),
                    truncated: projects.truncated,
                };
                return Ok((jql, empty));
            }
            bounded_truncated = projects.truncated;
            query.project_keys = projects
                .projects
                .into_iter()
                .map(|project| project.key)
                .collect();
            jql = build_jira_issue_jql(&query).map_err(|_| JiraSearchError::ScopeInvalid)?;
        }
        let sprint_field = sprint_field(client, credential, site);
        let mut listing = client.browse_issues(site, credential, &jql, sprint_field.as_deref())?;
        listing.truncated |= bounded_truncated;
        Ok((jql, listing))
    })
    .await?;
    let linked = linked_tickets(&state.store.lock(), &params.project_id)?;
    let mut truncated = listing.truncated;
    let issues = listing
        .issues
        .into_iter()
        .filter_map(|issue| {
            let value = issue_value(issue, &linked);
            truncated |= value.is_none();
            value
        })
        .collect();
    to_value(&PmJiraSearchResult {
        project_id: params.project_id,
        issues,
        truncated,
        jql,
    })
}

/// When a site's sprint field was read, and its id.
type SprintFieldEntry = (Instant, Option<String>);

/// The site's sprint field id, cached per site. A failed lookup leaves
/// issues without a sprint rather than failing the search.
fn sprint_field(
    client: &JiraCloudClient,
    credential: JiraCredential<'_>,
    site: &str,
) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, SprintFieldEntry>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some((read_at, field)) = cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(site)
        && read_at.elapsed() < SPRINT_FIELD_TTL
    {
        return field.clone();
    }
    let field = client.sprint_field_id(site, credential).ok()?;
    cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(site.to_owned(), (Instant::now(), field.clone()));
    field
}

/// Each linked ticket of the project by its normalized Jira browse URL.
pub(crate) fn linked_tickets(
    store: &PmStore,
    project_id: &str,
) -> Result<HashMap<String, String>, ControlError> {
    Ok(store
        .board(project_id)?
        .tickets
        .into_iter()
        .filter_map(|ticket| {
            let url = normalize_jira_issue_url(ticket.jira_url.as_deref()?)
                .ok()?
                .url;
            Some((url, ticket.id))
        })
        .collect())
}

fn category(category: JiraStatusCategory) -> PmJiraStatusCategory {
    match category {
        JiraStatusCategory::New => PmJiraStatusCategory::New,
        JiraStatusCategory::Indeterminate => PmJiraStatusCategory::Indeterminate,
        JiraStatusCategory::Done => PmJiraStatusCategory::Done,
    }
}

/// An issue as the contract shapes it; `None` for a key outside Jira's
/// uppercase form, which the browser cannot link.
pub(crate) fn issue_value(
    issue: JiraListedIssue,
    linked: &HashMap<String, String>,
) -> Option<PmJiraIssue> {
    let JiraListedIssue { snapshot, details } = issue;
    let (project, _) = snapshot.key.rsplit_once('-')?;
    if !valid_project_key(project) {
        return None;
    }
    Some(PmJiraIssue {
        pm_ticket_id: linked.get(&snapshot.url).cloned(),
        id: snapshot.external_id,
        key: snapshot.key,
        url: snapshot.url,
        title: snapshot.summary,
        issue_type: details.issue_type,
        status: PmJiraIssueStatus {
            name: snapshot.status_name,
            category: category(JiraStatusCategory::from_key(
                snapshot.status_category.as_deref(),
            )),
        },
        priority: details.priority,
        assignee: snapshot
            .assignee_display
            .map(|display_name| PmJiraIssueUser {
                display_name,
                avatar_url: details.assignee_avatar_url,
            }),
        reporter: details.reporter_display,
        labels: details.labels,
        sprint: details.sprint,
        updated_at_epoch_ms: details.updated_at_epoch_ms,
        created_at_epoch_ms: details
            .created_at_epoch_ms
            .unwrap_or(details.updated_at_epoch_ms),
    })
}
