//! Reads of the delivery tables. JSON columns hold one validated value
//! each; a value that no longer decodes or validates is a storage error.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params, types::Type};

use super::rows::parsed;
use crate::{
    DeliveryProbe, GitHubSource, JiraSource, PmError, ProbeAuthor, ProbeMatcher, ProbeStatus,
    ProjectSources, TicketDeliveryFacts,
};

fn json_column<T: serde::de::DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    let text: String = row.get(index)?;
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

fn invalid_row(index: usize) -> rusqlite::Error {
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

const PROBE_COLUMNS: &str = "id, project_id, environment, argv_json, matcher, status, author, \
     reason, created_at_epoch_ms, last_run_json";

fn probe_row(row: &Row<'_>) -> rusqlite::Result<DeliveryProbe> {
    let last_run: Option<String> = row.get(9)?;
    let probe = DeliveryProbe {
        id: row.get(0)?,
        project_id: row.get(1)?,
        environment: row.get(2)?,
        argv: json_column(row, 3)?,
        matcher: parsed(row, 4, ProbeMatcher::parse)?,
        status: parsed(row, 5, ProbeStatus::parse)?,
        author: parsed(row, 6, ProbeAuthor::parse)?,
        reason: row.get(7)?,
        created_at_epoch_ms: row.get(8)?,
        last_run: match last_run {
            Some(_) => Some(json_column(row, 9)?),
            None => None,
        },
    };
    if probe.is_valid() {
        Ok(probe)
    } else {
        Err(invalid_row(0))
    }
}

pub(crate) fn probe_by_id(
    connection: &Connection,
    probe_id: &str,
) -> Result<Option<DeliveryProbe>, PmError> {
    Ok(connection
        .query_row(
            &format!("SELECT {PROBE_COLUMNS} FROM delivery_probes WHERE id = ?1"),
            [probe_id],
            probe_row,
        )
        .optional()?)
}

/// A project's probes in creation order.
pub(crate) fn project_probes(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<DeliveryProbe>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {PROBE_COLUMNS} FROM delivery_probes WHERE project_id = ?1 \
         ORDER BY created_at_epoch_ms, id"
    ))?;
    let probes = statement
        .query_map([project_id], probe_row)?
        .collect::<Result<_, _>>()?;
    Ok(probes)
}

/// A project's sources; none configured is the empty value.
pub(crate) fn project_sources(
    connection: &Connection,
    project_id: &str,
) -> Result<ProjectSources, PmError> {
    let sources = connection
        .query_row(
            "SELECT jira_site_url, jira_board_id, jira_account_email, jira_credential_handle, \
                 github_owner, github_name \
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
