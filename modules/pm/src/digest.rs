//! What changed in a project since a moment: a pure reading of the store's
//! own timestamps (ticket creation and edits, description versions, pending
//! proposals, finished checks, sprint activation and closing, Jira pulls).
//! Nothing is recorded to produce it.

use rusqlite::params;

use crate::store::{project_checks, project_sprints, project_tickets, ticket_proposals};
use crate::validation::check_id;
use crate::{
    DeliveryCheck, PmError, PmStore, Sprint, Ticket, TicketAuthor, TicketProposal, TicketVersion,
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
    for ticket in source.tickets {
        let sprint = ticket.sprint_id.as_deref();
        push(
            DigestKind::TicketCreated,
            ticket.created_at_epoch_ms,
            Some(&ticket.id),
            sprint,
            format!("Created {}", ticket.title),
        );
        if ticket.updated_at_epoch_ms > ticket.created_at_epoch_ms {
            push(
                DigestKind::TicketUpdated,
                ticket.updated_at_epoch_ms,
                Some(&ticket.id),
                sprint,
                format!("Updated {}", ticket.title),
            );
        }
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
        Ok(digest(
            project_id,
            DigestSource {
                tickets: &tickets,
                sprints: &sprints,
                versions: &versions,
                proposals: &proposals,
                checks: &checks,
            },
            since_epoch_ms,
            until,
        ))
    }
}
