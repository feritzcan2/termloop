//! Reads of the delivery tables. JSON columns hold one validated value
//! each; a value that no longer decodes or validates is a storage error.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params, types::Type};

use termloop_providers::AzureRepository;

use crate::{
    GitHubSource, JiraSource, PmError, ProjectSources, TicketDeliveryFacts, TicketProposal,
};

pub(crate) fn json_column<T: serde::de::DeserializeOwned>(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<T> {
    let text: String = row.get(index)?;
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

pub(crate) fn invalid_row(index: usize) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, Type::Text, "invalid stored value".into())
}

pub(crate) fn to_json<T: serde::Serialize>(value: &T) -> Result<String, PmError> {
    serde_json::to_string(value).map_err(|error| PmError::Storage(error.to_string()))
}

fn facts_row(row: &Row<'_>) -> rusqlite::Result<TicketDeliveryFacts> {
    let facts: TicketDeliveryFacts = json_column(row, 0)?;
    if facts.is_valid() {
        Ok(facts)
    } else {
        Err(invalid_row(0))
    }
}

pub(crate) fn ticket_facts(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Option<TicketDeliveryFacts>, PmError> {
    Ok(connection
        .query_row(
            "SELECT facts_json FROM ticket_delivery_facts WHERE ticket_id = ?1",
            [ticket_id],
            facts_row,
        )
        .optional()?)
}

/// The facts of every ticket of a project, by ticket id.
pub(crate) fn project_facts(
    connection: &Connection,
    project_id: &str,
) -> Result<HashMap<String, TicketDeliveryFacts>, PmError> {
    let mut statement = connection.prepare(
        "SELECT f.facts_json FROM ticket_delivery_facts f \
         JOIN tickets t ON t.id = f.ticket_id WHERE t.project_id = ?1",
    )?;
    let facts = statement
        .query_map([project_id], facts_row)?
        .map(|facts| facts.map(|facts| (facts.ticket_id.clone(), facts)))
        .collect::<Result<_, _>>()?;
    Ok(facts)
}

/// A project's sources; none configured is the empty value.
pub(crate) fn project_sources(
    connection: &Connection,
    project_id: &str,
) -> Result<ProjectSources, PmError> {
    let sources = connection
        .query_row(
            "SELECT jira_site_url, jira_board_id, jira_account_email, jira_credential_handle, \
                 github_owner, github_name, azure_organization, azure_project, azure_repository \
             FROM project_sources WHERE project_id = ?1",
            params![project_id],
            |row| {
                let site_url: Option<String> = row.get(0)?;
                let owner: Option<String> = row.get(4)?;
                Ok(ProjectSources {
                    jira: match site_url {
                        Some(site_url) => Some(JiraSource {
                            site_url,
                            board_id: row.get(1)?,
                            account_email: row.get(2)?,
                            credential_handle: row.get(3)?,
                        }),
                        None => None,
                    },
                    github: match owner {
                        Some(owner) => Some(GitHubSource {
                            owner,
                            name: row.get(5)?,
                        }),
                        None => None,
                    },
                    azure_devops: match row.get::<_, Option<String>>(6)? {
                        Some(organization) => Some(AzureRepository {
                            organization,
                            project: row.get(7)?,
                            name: row.get(8)?,
                        }),
                        None => None,
                    },
                })
            },
        )
        .optional()?
        .unwrap_or_default();
    if sources.is_valid() {
        Ok(sources)
    } else {
        Err(PmError::Storage("invalid stored project sources".into()))
    }
}

const PROPOSAL_COLUMNS: &str = "id, ticket_id, change_json, summary, base_version, skill_id, \
     skill_version, evidence_json, created_at_epoch_ms";

fn proposal_row(row: &Row<'_>) -> rusqlite::Result<TicketProposal> {
    let proposal = TicketProposal {
        id: row.get(0)?,
        ticket_id: row.get(1)?,
        change: json_column(row, 2)?,
        summary: row.get(3)?,
        base_version: row.get(4)?,
        skill_id: row.get(5)?,
        skill_version: row.get(6)?,
        evidence: json_column(row, 7)?,
        created_at_epoch_ms: row.get(8)?,
    };
    if proposal.is_valid() {
        Ok(proposal)
    } else {
        Err(invalid_row(0))
    }
}

pub(crate) fn proposal_by_id(
    connection: &Connection,
    proposal_id: &str,
) -> Result<Option<TicketProposal>, PmError> {
    Ok(connection
        .query_row(
            &format!("SELECT {PROPOSAL_COLUMNS} FROM ticket_proposals WHERE id = ?1"),
            [proposal_id],
            proposal_row,
        )
        .optional()?)
}

/// A ticket's pending proposals, oldest first.
pub(crate) fn ticket_proposals(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Vec<TicketProposal>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {PROPOSAL_COLUMNS} FROM ticket_proposals WHERE ticket_id = ?1 \
         ORDER BY created_at_epoch_ms, id"
    ))?;
    let proposals = statement
        .query_map([ticket_id], proposal_row)?
        .collect::<Result<_, _>>()?;
    Ok(proposals)
}

/// The pending proposals of a project's skills, by ticket rank then age;
/// at most `limit`.
pub(crate) fn project_skill_proposals(
    connection: &Connection,
    project_id: &str,
    limit: usize,
) -> Result<Vec<TicketProposal>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {PROPOSAL_COLUMNS} FROM (SELECT p.*, t.rank AS ticket_rank \
             FROM ticket_proposals p JOIN tickets t ON t.id = p.ticket_id \
             WHERE t.project_id = ?1 AND p.skill_id IS NOT NULL) \
         ORDER BY ticket_rank, ticket_id, created_at_epoch_ms, id LIMIT ?2"
    ))?;
    let proposals = statement
        .query_map(params![project_id, limit], proposal_row)?
        .collect::<Result<_, _>>()?;
    Ok(proposals)
}

/// The pending proposals a skill made, oldest first.
pub(crate) fn skill_proposal_count(
    connection: &Connection,
    skill_id: &str,
) -> Result<u32, PmError> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM ticket_proposals WHERE skill_id = ?1",
        [skill_id],
        |row| row.get(0),
    )?)
}
