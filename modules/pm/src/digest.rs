//! What changed in a project since a moment: a reading of the store's own
//! timestamps (ticket creation and edits, description versions, pending
//! proposals, finished checks, sprint activation and closing, Jira pulls)
//! and of the ticket activity commands record (status, assignee, sprint
//! moves, blockers).

use rusqlite::params;

use crate::store::{project_checks, project_sprints, project_tickets, ticket_proposals};
use crate::validation::check_id;
use crate::{
    DeliveryCheck, PmError, PmStore, Sprint, Ticket, TicketActivity, TicketActivityKind,
    TicketAuthor, TicketProposal, TicketStatus, TicketVersion,
};

/// The most entries one digest returns; the newest are kept.
pub const DIGEST_ENTRIES_MAX: usize = 500;
const DIGEST_SUMMARY_MAX_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DigestKind {
    TicketCreated,
    TicketUpdated,
    DescriptionVersioned,
    ProposalCreated,
    CheckFinished,
    SprintActivated,
    SprintClosed,
    JiraPulled,
    StatusChanged,
    AssigneeChanged,
    TicketMoved,
    BlockerAdded,
    BlockerRemoved,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestEntry {
    pub kind: DigestKind,
    pub at_epoch_ms: u64,
    pub ticket_id: Option<String>,
    pub sprint_id: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Digest {
    pub project_id: String,
    pub since_epoch_ms: u64,
    pub until_epoch_ms: u64,
    /// Oldest first.
    pub entries: Vec<DigestEntry>,
    pub truncated: bool,
}

/// The rows a digest reads.
#[derive(Debug, Clone, Copy)]
pub struct DigestSource<'a> {
    pub tickets: &'a [Ticket],
    pub sprints: &'a [Sprint],
    pub versions: &'a [TicketVersion],
    pub proposals: &'a [TicketProposal],
    pub checks: &'a [DeliveryCheck],
    pub activity: &'a [TicketActivity],
}

fn bounded(summary: String) -> String {
    let line = summary
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(DIGEST_SUMMARY_MAX_CHARS)
        .collect::<String>();
    let line = line.trim();
    if line.is_empty() {
        "Changed".to_owned()
    } else {
        line.to_owned()
    }
}

fn status_label(status: &str) -> &str {
    match TicketStatus::parse(status) {
        Some(TicketStatus::Todo) => "To do",
        Some(TicketStatus::InProgress) => "In progress",
        Some(TicketStatus::InReview) => "In review",
        Some(TicketStatus::Done) => "Done",
        None => status,
    }
}

fn author(author: TicketAuthor) -> &'static str {
    match author {
        TicketAuthor::Pm => "the project manager",
        TicketAuthor::Agent => "the agent",
        TicketAuthor::Jira => "Jira",
    }
}

/// The entries in `(since, until]`, oldest first, keeping the newest
/// [`DIGEST_ENTRIES_MAX`].
pub fn digest(
    project_id: &str,
    source: DigestSource<'_>,
    since_epoch_ms: u64,
    until_epoch_ms: u64,
) -> Digest {
    let within = |at: u64| at > since_epoch_ms && at <= until_epoch_ms;
    let title = |ticket_id: &str| {
        source
            .tickets
            .iter()
            .find(|ticket| ticket.id == ticket_id)
            .map_or_else(|| ticket_id.to_owned(), |ticket| ticket.title.clone())
    };
    let mut entries = Vec::new();
    let mut push = |kind, at, ticket_id: Option<&str>, sprint_id: Option<&str>, summary| {
        if within(at) {
            entries.push(DigestEntry {
                kind,
                at_epoch_ms: at,
                ticket_id: ticket_id.map(str::to_owned),
                sprint_id: sprint_id.map(str::to_owned),
                summary: bounded(summary),
            });
        }
    };
    let sprint_name = |sprint_id: &str| {
        source
            .sprints
            .iter()
            .find(|sprint| sprint.id == sprint_id)
            .map_or_else(|| sprint_id.to_owned(), |sprint| sprint.name.clone())
    };
    // A ticket edit that a more specific entry already names (a status
    // change, a new description version, a blocker) is not repeated as a
    // bare "Updated" line.
    let explained = |ticket_id: &str, at: u64| {
        source
            .activity
            .iter()
            .any(|activity| activity.ticket_id == ticket_id && activity.at_epoch_ms == at)
            || source
                .versions
                .iter()
                .any(|version| version.ticket_id == ticket_id && version.recorded_at_epoch_ms == at)
    };
    for ticket in source.tickets {
        let sprint = ticket.sprint_id.as_deref();
        push(
            DigestKind::TicketCreated,
            ticket.created_at_epoch_ms,
            Some(&ticket.id),
            sprint,
            format!("Created {}", ticket.title),
        );
        if ticket.updated_at_epoch_ms > ticket.created_at_epoch_ms
            && !explained(&ticket.id, ticket.updated_at_epoch_ms)
        {
            push(
                DigestKind::TicketUpdated,
                ticket.updated_at_epoch_ms,
                Some(&ticket.id),
                sprint,
                format!("Updated {}", ticket.title),
            );
        }
    }
    for activity in source.activity {
        let ticket = title(&activity.ticket_id);
        let detail = activity.detail.as_deref();
        let (kind, summary) = match activity.kind {
            TicketActivityKind::Status => (
                DigestKind::StatusChanged,
                format!("{ticket} moved to {}", status_label(detail.unwrap_or("?"))),
            ),
            TicketActivityKind::Assignee => (
                DigestKind::AssigneeChanged,
                match detail {
                    Some(assignee) => format!("{ticket} assigned to {assignee}"),
                    None => format!("{ticket} unassigned"),
                },
            ),
            TicketActivityKind::Moved => (
                DigestKind::TicketMoved,
                match detail {
                    Some(sprint_id) => format!("{ticket} moved to {}", sprint_name(sprint_id)),
                    None => format!("{ticket} moved to the backlog"),
                },
            ),
            TicketActivityKind::BlockerAdded => (
                DigestKind::BlockerAdded,
                format!("{ticket} blocked: {}", detail.unwrap_or_default()),
            ),
            TicketActivityKind::BlockerRemoved => (
                DigestKind::BlockerRemoved,
                format!("{ticket} unblocked: {}", detail.unwrap_or_default()),
            ),
        };
        let sprint = (activity.kind == TicketActivityKind::Moved)
            .then_some(detail)
            .flatten();
        push(
            kind,
            activity.at_epoch_ms,
            Some(&activity.ticket_id),
            sprint,
            summary,
        );
    }
    for version in source.versions {
        push(
            DigestKind::DescriptionVersioned,
            version.recorded_at_epoch_ms,
            Some(&version.ticket_id),
            None,
            format!(
                "Description of {} saved as version {} by {}",
                title(&version.ticket_id),
                version.number,
                author(version.author)
            ),
        );
    }
    for proposal in source.proposals {
        push(
            DigestKind::ProposalCreated,
            proposal.created_at_epoch_ms,
            Some(&proposal.ticket_id),
            None,
            format!(
                "Proposed for {}: {}",
                title(&proposal.ticket_id),
                proposal.summary
            ),
        );
    }
    for check in source.checks {
        if let (Some(finished), Some(outcome)) = (check.finished_at_epoch_ms, check.outcome) {
            push(
                DigestKind::CheckFinished,
                finished,
                Some(&check.ticket_id),
                None,
                format!(
                    "Delivery check of {} {}",
                    title(&check.ticket_id),
                    outcome.as_str()
                ),
            );
        }
    }
    let mut pulls = Vec::new();
    for sprint in source.sprints {
        if let Some(at) = sprint.activated_at_epoch_ms {
            push(
                DigestKind::SprintActivated,
                at,
                None,
                Some(&sprint.id),
                format!("Started {}", sprint.name),
            );
        }
        if let Some(at) = sprint.closed_at_epoch_ms {
            push(
                DigestKind::SprintClosed,
                at,
                None,
                Some(&sprint.id),
                format!("Closed {}", sprint.name),
            );
        }
        pulls.extend(sprint.jira_pulled_at_epoch_ms);
    }
    // One pull stamps every sprint it saw with the same time.
    pulls.sort_unstable();
    pulls.dedup();
    for at in pulls {
        push(
            DigestKind::JiraPulled,
            at,
            None,
            None,
            "Pulled sprints from Jira".to_owned(),
        );
    }
    entries.sort_by(|left, right| {
        left.at_epoch_ms
            .cmp(&right.at_epoch_ms)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.ticket_id.cmp(&right.ticket_id))
            .then_with(|| left.sprint_id.cmp(&right.sprint_id))
    });
    let truncated = entries.len() > DIGEST_ENTRIES_MAX;
    if truncated {
        entries.drain(..entries.len() - DIGEST_ENTRIES_MAX);
    }
    Digest {
        project_id: project_id.to_owned(),
        since_epoch_ms,
        until_epoch_ms,
        entries,
        truncated,
    }
}

impl PmStore {
    /// What changed in a project after `since_epoch_ms`, up to now.
    pub fn digest(&self, project_id: &str, since_epoch_ms: u64) -> Result<Digest, PmError> {
        check_id(project_id, "projectId")?;
        let connection = self.connection();
        let until = self.now().max(since_epoch_ms);
        let tickets = project_tickets(connection, project_id)?;
        let sprints = project_sprints(connection, project_id)?;
        let checks = project_checks(connection, project_id)?;
        let mut proposals = Vec::new();
        for ticket in &tickets {
            proposals.extend(ticket_proposals(connection, &ticket.id)?);
        }
        let mut statement = connection.prepare(
            "SELECT v.ticket_id, v.number, v.author, v.recorded_at_epoch_ms \
             FROM ticket_versions v JOIN tickets t ON t.id = v.ticket_id \
             WHERE t.project_id = ?1 AND v.recorded_at_epoch_ms > ?2",
        )?;
        let versions = statement
            .query_map(params![project_id, since_epoch_ms], |row| {
                Ok(TicketVersion {
                    ticket_id: row.get(0)?,
                    number: row.get(1)?,
                    // The digest names versions; it never quotes them.
                    description: String::new(),
                    author: crate::store::parsed(row, 2, TicketAuthor::parse)?,
                    recorded_at_epoch_ms: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut statement = connection.prepare(
            "SELECT a.ticket_id, a.kind, a.detail, a.recorded_at_epoch_ms \
             FROM ticket_activity a JOIN tickets t ON t.id = a.ticket_id \
             WHERE t.project_id = ?1 AND a.recorded_at_epoch_ms > ?2 ORDER BY a.id",
        )?;
        let activity = statement
            .query_map(params![project_id, since_epoch_ms], |row| {
                Ok(TicketActivity {
                    ticket_id: row.get(0)?,
                    kind: crate::store::parsed(row, 1, TicketActivityKind::parse)?,
                    detail: row.get(2)?,
                    at_epoch_ms: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(digest(
            project_id,
            DigestSource {
                tickets: &tickets,
                sprints: &sprints,
                versions: &versions,
                proposals: &proposals,
                checks: &checks,
                activity: &activity,
            },
            since_epoch_ms,
            until,
        ))
    }
}
