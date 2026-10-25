//! Confirmed write-back to a ticket's Jira issue. The PM first sees what
//! would change in Jira (title, description, status, sprint), computed from
//! a fresh read; only that exact diff, confirmed by its token, is written.
//! Applying re-reads Jira and refuses when the diff it computes now differs
//! from the confirmed one. Nothing about the write is stored except the
//! issue's sprint after a move: Jira is the record of what was written.
//!
//! The credential goes only to the project's Jira site, and only for an
//! issue whose browse URL is on that site.

use rusqlite::params;
use sha2::{Digest, Sha256};
use termloop_providers::{
    JIRA_DESCRIPTION_MAX_CHARS, JiraCredential, JiraIssueText, JiraIssueWriter, JiraTransition,
    JiraWriteError, jira_issue_url_on_site, markdown_to_jira_wiki,
};

use super::{check_id, require_ticket};
use crate::store::{project_sources, sprint_by_id};
use crate::{PmError, PmStore, SprintState, Ticket, TicketStatus};

/// Where a ticket's confirmed Jira write goes. It holds the credential
/// handle the caller resolves, never the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraWriteTarget {
    pub ticket_id: String,
    pub site_url: String,
    pub account_email: String,
    pub credential_handle: String,
    pub issue_key: String,
}

/// The issue as Jira holds it now, with the transitions it offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraIssueState {
    pub issue: JiraIssueText,
    pub transitions: Vec<JiraTransition>,
}

/// One field Jira would change.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "field"
)]
pub enum JiraChange {
    Summary {
        jira: String,
        ticket: String,
    },
    /// The ticket description as Jira wiki markup.
    Description {
        jira: Option<String>,
        ticket: String,
    },
    Status {
        jira: Option<String>,
        to_status: String,
        transition_id: String,
        transition_name: String,
    },
    /// `None` is the Jira backlog.
    Sprint {
        jira_sprint_id: Option<u64>,
        ticket_sprint_id: Option<u64>,
    },
    /// An accepted comment suggestion, as Jira wiki markup.
    Comment {
        comment_id: String,
        body: String,
    },
}

/// What a confirmed write would change in Jira.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraWriteDiff {
    pub ticket_id: String,
    pub issue_key: String,
    /// Jira's `updated` stamp the diff was computed against.
    pub jira_updated: String,
    /// The ticket's description version the diff carries (0 for none).
    pub ticket_version: u64,
    pub changes: Vec<JiraChange>,
    /// The ticket's status has no Jira transition from the issue's current
    /// status; it is left out of `changes`.
    pub status_unreachable: bool,
    /// The confirmation token: a hash of everything above.
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JiraWriteOutcome {
    /// Every change was written, in order.
    Applied(Vec<JiraChange>),
    /// Jira or the ticket changed since the diff was confirmed; nothing was
    /// written. The current diff is returned for review.
    Stale(JiraWriteDiff),
    /// A read or write failed. `applied` lists the changes Jira accepted
    /// before it.
    Failed {
        applied: Vec<JiraChange>,
        error: JiraWriteError,
    },
}

/// Reads the issue and its transitions through a provider.
pub fn read_jira_issue_state(
    writer: &impl JiraIssueWriter,
    target: &JiraWriteTarget,
    credential: JiraCredential<'_>,
) -> Result<JiraIssueState, JiraWriteError> {
    Ok(JiraIssueState {
        issue: writer.read_issue(&target.site_url, credential, &target.issue_key)?,
        transitions: writer.transitions(&target.site_url, credential, &target.issue_key)?,
    })
}

/// The Jira status category a ticket status belongs to.
fn status_category(status: TicketStatus) -> &'static str {
    match status {
        TicketStatus::Todo => "new",
        TicketStatus::InProgress | TicketStatus::InReview => "indeterminate",
        TicketStatus::Done => "done",
    }
}

/// A ticket's accepted Jira comments waiting for a confirmed write, oldest
/// first.
fn queued_comments(
    connection: &rusqlite::Connection,
    ticket_id: &str,
) -> Result<Vec<(String, String)>, PmError> {
    let mut statement = connection.prepare(
        "SELECT id, body FROM ticket_jira_comments WHERE ticket_id = ?1 \
         ORDER BY queued_at_epoch_ms, id",
    )?;
    let comments = statement
        .query_map([ticket_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(comments)
}

fn token(diff: &JiraWriteDiff) -> Result<String, PmError> {
    let canonical = serde_json::to_vec(&(
        &diff.ticket_id,
        &diff.issue_key,
        &diff.jira_updated,
        diff.ticket_version,
        &diff.changes,
        diff.status_unreachable,
    ))
    .map_err(|error| PmError::Storage(error.to_string()))?;
    Ok(Sha256::digest(canonical)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

impl PmStore {
    /// Where a ticket's Jira write goes. Refused unless the ticket links an
    /// issue on its project's Jira site.
    pub fn jira_write_target(&self, ticket_id: &str) -> Result<JiraWriteTarget, PmError> {
        let ticket = require_ticket(self.connection(), ticket_id)?;
        let (Some(url), Some(issue_key)) = (ticket.jira_url.as_deref(), ticket.jira_issue_key())
        else {
            return Err(PmError::Constraint(
                "the ticket is not linked to a Jira issue",
            ));
        };
        let jira = project_sources(self.connection(), &ticket.project_id)?
            .jira
            .ok_or(PmError::Constraint("the project has no Jira source"))?;
        if !jira_issue_url_on_site(&jira.site_url, url) {
            return Err(PmError::Constraint(
                "the issue is not on the project's Jira site",
            ));
        }
        Ok(JiraWriteTarget {
            ticket_id: ticket.id,
            site_url: jira.site_url,
            account_email: jira.account_email,
            credential_handle: jira.credential_handle,
            issue_key,
        })
    }

    /// What writing the ticket to Jira would change, from a fresh read.
    pub fn jira_write_diff(
        &self,
        ticket_id: &str,
        state: &JiraIssueState,
    ) -> Result<JiraWriteDiff, PmError> {
        let target = self.jira_write_target(ticket_id)?;
        if !state.issue.key.eq_ignore_ascii_case(&target.issue_key) {
            return Err(PmError::Invalid("issue"));
        }
        let ticket = require_ticket(self.connection(), ticket_id)?;
        let mut changes = Vec::new();
        if state.issue.summary != ticket.title {
            changes.push(JiraChange::Summary {
                jira: state.issue.summary.clone(),
                ticket: ticket.title.clone(),
            });
        }
        let description = markdown_to_jira_wiki(&ticket.description);
        if description.chars().count() > JIRA_DESCRIPTION_MAX_CHARS {
            return Err(PmError::Invalid("description"));
        }
        if state
            .issue
            .description
            .as_deref()
            .unwrap_or_default()
            .trim()
            != description.trim()
        {
            changes.push(JiraChange::Description {
                jira: state.issue.description.clone(),
                ticket: description,
            });
        }
        let wanted = status_category(ticket.status);
        let mut status_unreachable = false;
        if state.issue.status_category.as_deref() != Some(wanted) {
            match state
                .transitions
                .iter()
                .find(|transition| transition.to_status_category.as_deref() == Some(wanted))
            {
                Some(transition) => changes.push(JiraChange::Status {
                    jira: state.issue.status_name.clone(),
                    to_status: transition.to_status.clone(),
                    transition_id: transition.id.clone(),
                    transition_name: transition.name.clone(),
                }),
                None => status_unreachable = true,
            }
        }
        if let Some(change) = self.sprint_change(&ticket)? {
            changes.push(change);
        }
        for (comment_id, body) in queued_comments(self.connection(), &ticket.id)? {
            changes.push(JiraChange::Comment {
                comment_id,
                body: markdown_to_jira_wiki(&body),
            });
        }
        let mut diff = JiraWriteDiff {
            ticket_id: ticket.id,
            issue_key: target.issue_key,
            jira_updated: state.issue.updated.clone(),
            ticket_version: ticket.versions.map_or(0, |versions| versions.head_number),
            changes,
            status_unreachable,
            token: String::new(),
        };
        diff.token = token(&diff)?;
        Ok(diff)
    }

    /// The sprint move a ticket implies: only for an issue a sprint pull has
    /// seen, toward its mirrored sprint or the backlog.
    fn sprint_change(&self, ticket: &Ticket) -> Result<Option<JiraChange>, PmError> {
        if ticket.jira_pulled_at_epoch_ms.is_none() {
            return Ok(None);
        }
        let wanted = match ticket.sprint_id.as_deref() {
            None => None,
            Some(sprint_id) => {
                let Some(sprint) = sprint_by_id(self.connection(), sprint_id)? else {
                    return Ok(None);
                };
                match sprint.jira_sprint_id {
                    Some(jira_sprint_id) if sprint.state != SprintState::Closed => {
                        Some(jira_sprint_id)
                    }
                    // A local or closed sprint has no Jira sprint to move to.
                    _ => return Ok(None),
                }
            }
        };
        Ok(
            (wanted != ticket.jira_sprint_id).then_some(JiraChange::Sprint {
                jira_sprint_id: ticket.jira_sprint_id,
                ticket_sprint_id: wanted,
            }),
        )
    }

    /// Drops a queued Jira comment once Jira has it.
    fn drop_queued_comment(&mut self, comment_id: &str) -> Result<(), PmError> {
        check_id(comment_id, "commentId")?;
        self.write(|transaction| {
            transaction.execute(
                "DELETE FROM ticket_jira_comments WHERE id = ?1",
                [comment_id],
            )?;
            Ok(())
        })
    }

    /// Records the Jira sprint an issue was moved to.
    fn record_jira_sprint(
        &mut self,
        ticket_id: &str,
        jira_sprint_id: Option<u64>,
    ) -> Result<(), PmError> {
        check_id(ticket_id, "ticketId")?;
        self.write(|transaction| {
            transaction.execute(
                "UPDATE tickets SET jira_sprint_id = ?2 WHERE id = ?1",
                params![ticket_id, jira_sprint_id],
            )?;
            Ok(())
        })
    }
}

/// Writes a confirmed diff to Jira. Jira is read again first; when the diff
/// computed now has another token than `confirmed_token`, nothing is
/// written. No transaction is open while Jira is called.
pub fn apply_jira_write(
    store: &mut PmStore,
    writer: &impl JiraIssueWriter,
    credential: JiraCredential<'_>,
    ticket_id: &str,
    confirmed_token: &str,
) -> Result<JiraWriteOutcome, PmError> {
    let target = store.jira_write_target(ticket_id)?;
    let state = match read_jira_issue_state(writer, &target, credential) {
        Ok(state) => state,
        Err(error) => {
            return Ok(JiraWriteOutcome::Failed {
                applied: Vec::new(),
                error,
            });
        }
    };
    let diff = store.jira_write_diff(ticket_id, &state)?;
    if diff.token != confirmed_token {
        return Ok(JiraWriteOutcome::Stale(diff));
    }
    let ticket = require_ticket(store.connection(), ticket_id)?;
    let (site, key) = (target.site_url.as_str(), target.issue_key.as_str());
    let mut applied = Vec::new();
    let text_changes = diff
        .changes
        .iter()
        .filter(|change| {
            matches!(
                change,
                JiraChange::Summary { .. } | JiraChange::Description { .. }
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if !text_changes.is_empty() {
        let description = markdown_to_jira_wiki(&ticket.description);
        if let Err(error) = writer.update_issue(site, credential, key, &ticket.title, &description)
        {
            return Ok(JiraWriteOutcome::Failed { applied, error });
        }
        applied.extend(text_changes);
    }
    for change in &diff.changes {
        let result = match change {
            JiraChange::Status { transition_id, .. } => {
                writer.transition_issue(site, credential, key, transition_id)
            }
            JiraChange::Sprint {
                ticket_sprint_id, ..
            } => writer
                .move_issue(site, credential, key, *ticket_sprint_id)
                .map(|()| {
                    // Jira accepted the move; a failure to record it only
                    // shows the move again next time.
                    let _ = store.record_jira_sprint(ticket_id, *ticket_sprint_id);
                }),
            JiraChange::Comment { comment_id, body } => {
                writer.add_comment(site, credential, key, body).map(|()| {
                    // Posted; a failure to drop it would show it again, so
                    // it is dropped before anything else is written.
                    let _ = store.drop_queued_comment(comment_id);
                })
            }
            JiraChange::Summary { .. } | JiraChange::Description { .. } => continue,
        };
        if let Err(error) = result {
            return Ok(JiraWriteOutcome::Failed { applied, error });
        }
        applied.push(change.clone());
    }
    Ok(JiraWriteOutcome::Applied(applied))
}
