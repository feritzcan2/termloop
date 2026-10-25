//! The Jira sprint mirror. A project whose Jira source names a board takes
//! that board's sprints from Jira: Jira owns a mirrored sprint's name, end,
//! and state, and which linked issues its active sprint holds. Tickets
//! without a Jira link keep the sprint the PM gave them.
//!
//! A pull is planned from the store, read through `termloop-providers`
//! outside any transaction, and applied in one transaction. A failed read,
//! or one planned against sources that changed or older than the last
//! applied pull, changes nothing.

use std::collections::HashSet;

use rusqlite::{Connection, params};
use termloop_providers::{
    JiraCredential, JiraIssueSnapshot, JiraSearchError, JiraSearchResult, JiraSprint,
    JiraSprintListResult, JiraSprintSource, JiraSprintState, jira_issue_url_on_site,
};

use super::sprint::close_open_sprint;
use super::ticket::record_version;
use super::{check_id, next_rank};
use crate::sprint::{PROJECT_OPEN_SPRINTS_MAX, SPRINT_NAME_MAX_CHARS};
use crate::store::{active_sprint, project_sources, project_sprints, project_tickets};
use crate::ticket::{
    TICKET_ASSIGNEE_MAX_CHARS, TICKET_DESCRIPTION_MAX_CHARS, TICKET_TITLE_MAX_CHARS,
    valid_jira_url, valid_ticket_description,
};
use crate::{PmError, PmStore, Sprint, SprintState, TicketAuthor, TicketStatus};

/// The most tickets one pull copies from the active sprint.
pub const JIRA_PULL_NEW_TICKETS_MAX: usize = 100;

/// One planned sprint read of a project's Jira board.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraSprintPull {
    pub project_id: String,
    pub site_url: String,
    pub board_id: u64,
    /// The account and credential handle to read with; never the token.
    pub account_email: String,
    pub credential_handle: String,
    pub planned_at_epoch_ms: u64,
}

/// What one read of a board returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraSprintRead {
    pub sprints: JiraSprintListResult,
    /// The issues of the board's active sprint, when it has one.
    pub active_issues: Option<JiraSearchResult>,
}

/// What applying one pull did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JiraPullOutcome {
    /// The read failed; nothing changed.
    Failed(JiraSearchError),
    /// The project's sources changed since the pull was planned, or a newer
    /// pull was already applied; nothing changed.
    Stale,
    /// The board has no sprints feature; nothing changed.
    SprintsUnsupported,
    Applied(JiraPullChanges),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JiraPullChanges {
    pub sprints_created: Vec<String>,
    pub sprints_closed: Vec<String>,
    pub tickets_created: Vec<String>,
    pub tickets_moved: Vec<String>,
    /// Jira sprints or issues left out because a bound was reached.
    pub skipped: usize,
}

/// Reads one planned pull through a provider. The credential is the one the
/// caller resolved from the pull's handle; it is used for this read only.
pub fn read_jira_sprints(
    source: &impl JiraSprintSource,
    pull: &JiraSprintPull,
    credential: JiraCredential<'_>,
) -> Result<JiraSprintRead, JiraSearchError> {
    let sprints = source.list_sprints(&pull.site_url, credential, pull.board_id)?;
    let active = match &sprints {
        JiraSprintListResult::Sprints { sprints, .. } => sprints
            .iter()
            .find(|sprint| sprint.state == JiraSprintState::Active)
            .map(|sprint| sprint.id),
        JiraSprintListResult::SprintsUnsupported => None,
    };
    let active_issues = match active {
        Some(sprint_id) => Some(source.sprint_issues(&pull.site_url, credential, sprint_id)?),
        None => None,
    };
    Ok(JiraSprintRead {
        sprints,
        active_issues,
    })
}

/// A Jira sprint name as a PM sprint name.
fn sprint_name(sprint: &JiraSprint) -> String {
    single_line(&sprint.name, SPRINT_NAME_MAX_CHARS)
        .unwrap_or_else(|| format!("Sprint {}", sprint.id))
}

/// Jira text as a trimmed, bounded single-line label.
fn single_line(text: &str, max_chars: usize) -> Option<String> {
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

fn status_from_category(category: Option<&str>) -> TicketStatus {
    match category {
        Some("indeterminate") => TicketStatus::InProgress,
        Some("done") => TicketStatus::Done,
        _ => TicketStatus::Todo,
    }
}

fn mirrored_sprint(sprints: &[Sprint], jira_sprint_id: u64) -> Option<&Sprint> {
    sprints
        .iter()
        .find(|sprint| sprint.jira_sprint_id == Some(jira_sprint_id))
}

impl PmStore {
    /// The next sprint pull of a project, when its Jira source names a
    /// board.
    pub fn plan_jira_sprint_pull(
        &self,
        project_id: &str,
    ) -> Result<Option<JiraSprintPull>, PmError> {
        check_id(project_id, "projectId")?;
        let Some(jira) = project_sources(self.connection(), project_id)?.jira else {
            return Ok(None);
        };
        Ok(jira.board_id.map(|board_id| JiraSprintPull {
            project_id: project_id.to_owned(),
            site_url: jira.site_url,
            board_id,
            account_email: jira.account_email,
            credential_handle: jira.credential_handle,
            planned_at_epoch_ms: self.now(),
        }))
    }

    /// Applies one sprint read to the project's sprints and tickets.
    pub fn apply_jira_sprint_pull(
        &mut self,
        pull: &JiraSprintPull,
        read: Result<JiraSprintRead, JiraSearchError>,
    ) -> Result<JiraPullOutcome, PmError> {
        check_id(&pull.project_id, "projectId")?;
        let read = match read {
            Ok(read) => read,
            Err(error) => return Ok(JiraPullOutcome::Failed(error)),
        };
        let now = self.now();
        let ids = self.id_source();
        self.write(|transaction| {
            let current = project_sources(transaction, &pull.project_id)?.jira;
            let unchanged = current.is_some_and(|jira| {
                jira.site_url == pull.site_url && jira.board_id == Some(pull.board_id)
            });
            let sprints = project_sprints(transaction, &pull.project_id)?;
            let newer_applied = sprints
                .iter()
                .filter_map(|sprint| sprint.jira_pulled_at_epoch_ms)
                .any(|pulled_at| pulled_at > pull.planned_at_epoch_ms);
            if !unchanged || newer_applied {
                return Ok(JiraPullOutcome::Stale);
            }
            let JiraSprintListResult::Sprints {
                sprints: observed,
                truncated,
            } = &read.sprints
            else {
                return Ok(JiraPullOutcome::SprintsUnsupported);
            };
            let mut changes = JiraPullChanges::default();
            let active = mirror_sprints(
                transaction,
                pull,
                &sprints,
                observed,
                *truncated,
                now,
                ids,
                &mut changes,
            )?;
            if let (Some((sprint_id, jira_sprint_id)), Some(issues)) = (active, &read.active_issues)
            {
                mirror_active_issues(
                    transaction,
                    pull,
                    &sprint_id,
                    jira_sprint_id,
                    issues,
                    now,
                    ids,
                    &mut changes,
                )?;
            }
            Ok(JiraPullOutcome::Applied(changes))
        })
    }
}

/// Mirrors the board's listed sprints. Returns the PM sprint mirroring
/// Jira's active sprint with that sprint's Jira id.
#[allow(clippy::too_many_arguments)]
fn mirror_sprints(
    connection: &Connection,
    pull: &JiraSprintPull,
    existing: &[Sprint],
    observed: &[JiraSprint],
    truncated: bool,
    now: u64,
    ids: fn() -> String,
    changes: &mut JiraPullChanges,
) -> Result<Option<(String, u64)>, PmError> {
    let mut seen = HashSet::new();
    let observed = observed
        .iter()
        .filter(|sprint| sprint.state != JiraSprintState::Closed && seen.insert(sprint.id))
        .collect::<Vec<_>>();
    let jira_active = observed
        .iter()
        .find(|sprint| sprint.state == JiraSprintState::Active)
        .map(|sprint| sprint.id);
    // A mirrored open sprint of this board Jira no longer lists has closed;
    // its unfinished tickets go to the backlog. A partial list proves
    // nothing about the sprints it leaves out, except the active one.
    for sprint in existing.iter().filter(|sprint| {
        sprint.state != SprintState::Closed
            && sprint.jira_board_id == Some(pull.board_id)
            && sprint
                .jira_sprint_id
                .is_some_and(|id| !observed.iter().any(|jira| jira.id == id))
            && (!truncated || sprint.state == SprintState::Active)
    }) {
        close_open_sprint(connection, sprint, None, now)?;
        changes.sprints_closed.push(sprint.id.clone());
    }
    // Jira's active sprint is the project's only active one.
    if let Some(jira_active) = jira_active
        && let Some(local) = active_sprint(connection, &pull.project_id)?
        && local.jira_sprint_id != Some(jira_active)
    {
        connection.execute(
            "UPDATE sprints SET state = 'planned' WHERE id = ?1",
            [&local.id],
        )?;
    }
    let mut open: usize = connection.query_row(
        "SELECT COUNT(*) FROM sprints WHERE project_id = ?1 AND state != 'closed'",
        [&pull.project_id],
        |row| row.get(0),
    )?;
    let mut active = None;
    for jira in observed {
        let name = sprint_name(jira);
        let state = if jira.state == JiraSprintState::Active {
            SprintState::Active
        } else {
            SprintState::Planned
        };
        let sprint_id = match mirrored_sprint(existing, jira.id) {
            // A closed sprint stays frozen even if Jira lists it again.
            Some(sprint) if sprint.state == SprintState::Closed => continue,
            Some(sprint) => {
                connection.execute(
                    "UPDATE sprints SET name = ?2, ends_at_epoch_ms = ?3, state = ?4, \
                         activated_at_epoch_ms = CASE WHEN ?4 = 'active' \
                             THEN COALESCE(activated_at_epoch_ms, ?5) \
                             ELSE activated_at_epoch_ms END, \
                         jira_pulled_at_epoch_ms = ?5 \
                     WHERE id = ?1",
                    params![sprint.id, name, jira.end_epoch_ms, state.as_str(), now],
                )?;
                sprint.id.clone()
            }
            None if open >= PROJECT_OPEN_SPRINTS_MAX => {
                changes.skipped += 1;
                continue;
            }
            None => {
                let id = ids();
                connection.execute(
                    "INSERT INTO sprints (id, project_id, name, state, created_at_epoch_ms, \
                         activated_at_epoch_ms, ends_at_epoch_ms, jira_sprint_id, \
                         jira_board_id, jira_pulled_at_epoch_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?5)",
                    params![
                        id,
                        pull.project_id,
                        name,
                        state.as_str(),
                        now,
                        (state == SprintState::Active).then_some(now),
                        jira.end_epoch_ms,
                        jira.id,
                        jira.board_id
                    ],
                )?;
                open += 1;
                changes.sprints_created.push(id.clone());
                id
            }
        };
        if state == SprintState::Active {
            active = Some((sprint_id, jira.id));
        }
    }
    Ok(active)
}

/// Puts the linked tickets of Jira's active sprint into its mirror, copies
/// issues no ticket links yet into new tickets, and, when Jira listed the
/// whole sprint, returns linked tickets that left it to the backlog.
#[allow(clippy::too_many_arguments)]
fn mirror_active_issues(
    connection: &Connection,
    pull: &JiraSprintPull,
    sprint_id: &str,
    jira_sprint_id: u64,
    issues: &JiraSearchResult,
    now: u64,
    ids: fn() -> String,
    changes: &mut JiraPullChanges,
) -> Result<(), PmError> {
    let tickets = project_tickets(connection, &pull.project_id)?;
    let sprints = project_sprints(connection, &pull.project_id)?;
    let closed = |sprint: Option<&str>| {
        sprint.is_some_and(|id| {
            sprints
                .iter()
                .any(|sprint| sprint.id == id && sprint.state == SprintState::Closed)
        })
    };
    let move_ticket = |ticket_id: &str, target: Option<&str>, jira: Option<u64>| {
        let rank = next_rank(connection, &pull.project_id, target)?;
        connection.execute(
            "UPDATE tickets SET sprint_id = ?2, rank = ?3, jira_sprint_id = ?4, \
                 jira_pulled_at_epoch_ms = ?5, updated_at_epoch_ms = ?5 WHERE id = ?1",
            params![ticket_id, target, rank, jira, now],
        )?;
        Ok::<_, PmError>(())
    };
    let mut listed = HashSet::new();
    let mut created = 0;
    for issue in &issues.issues {
        if !valid_jira_url(&issue.url) || !jira_issue_url_on_site(&pull.site_url, &issue.url) {
            changes.skipped += 1;
            continue;
        }
        match tickets
            .iter()
            .find(|ticket| ticket.jira_url.as_deref() == Some(issue.url.as_str()))
        {
            Some(ticket) => {
                listed.insert(ticket.id.as_str());
                if ticket.sprint_id.as_deref() == Some(sprint_id) {
                    connection.execute(
                        "UPDATE tickets SET jira_sprint_id = ?2, jira_pulled_at_epoch_ms = ?3 \
                         WHERE id = ?1",
                        params![ticket.id, jira_sprint_id, now],
                    )?;
                } else if !closed(ticket.sprint_id.as_deref()) {
                    move_ticket(&ticket.id, Some(sprint_id), Some(jira_sprint_id))?;
                    changes.tickets_moved.push(ticket.id.clone());
                }
            }
            None if created >= JIRA_PULL_NEW_TICKETS_MAX => changes.skipped += 1,
            None => {
                let id = ids();
                insert_issue_ticket(connection, pull, &id, issue, sprint_id, jira_sprint_id, now)?;
                created += 1;
                changes.tickets_created.push(id);
            }
        }
    }
    if !issues.truncated {
        for ticket in tickets.iter().filter(|ticket| {
            ticket.jira_url.is_some()
                && ticket.sprint_id.as_deref() == Some(sprint_id)
                && !listed.contains(ticket.id.as_str())
        }) {
            move_ticket(&ticket.id, None, None)?;
            changes.tickets_moved.push(ticket.id.clone());
        }
    }
    Ok(())
}

fn insert_issue_ticket(
    connection: &Connection,
    pull: &JiraSprintPull,
    id: &str,
    issue: &JiraIssueSnapshot,
    sprint_id: &str,
    jira_sprint_id: u64,
    now: u64,
) -> Result<(), PmError> {
    // The summary alone: a confirmed write sends the title back as it is.
    let title =
        single_line(&issue.summary, TICKET_TITLE_MAX_CHARS).unwrap_or_else(|| issue.key.clone());
    let description = issue
        .description
        .as_deref()
        .map(|text| {
            text.chars()
                .take(TICKET_DESCRIPTION_MAX_CHARS)
                .collect::<String>()
        })
        .filter(|text| valid_ticket_description(text))
        .unwrap_or_default();
    let assignee = issue
        .assignee_display
        .as_deref()
        .and_then(|name| single_line(name, TICKET_ASSIGNEE_MAX_CHARS));
    let rank = next_rank(connection, &pull.project_id, Some(sprint_id))?;
    connection.execute(
        "INSERT INTO tickets (id, project_id, title, status, priority, assignee, sprint_id, \
             rank, jira_url, jira_sprint_id, jira_pulled_at_epoch_ms, created_at_epoch_ms, \
             updated_at_epoch_ms) \
         VALUES (?1, ?2, ?3, ?4, 'medium', ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10)",
        params![
            id,
            pull.project_id,
            title,
            status_from_category(issue.status_category.as_deref()).as_str(),
            assignee,
            sprint_id,
            rank,
            issue.url,
            jira_sprint_id,
            now
        ],
    )?;
    record_version(connection, id, &description, TicketAuthor::Jira, None, now)?;
    Ok(())
}
