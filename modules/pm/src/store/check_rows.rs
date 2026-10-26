//! Reads of the delivery check table.

use rusqlite::{Connection, OptionalExtension, Row, types::Type};

use crate::PmError;
use crate::delivery::checks::{DeliveryCheck, DeliveryCheckOutcome, DeliveryCheckReason};

const CHECK_COLUMNS: &str = "id, project_id, ticket_id, step_id, reason, started_at_epoch_ms, \
     finished_at_epoch_ms, outcome";

fn invalid(index: usize) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, Type::Text, "invalid stored value".into())
}

fn check_row(row: &Row<'_>) -> rusqlite::Result<DeliveryCheck> {
    let reason: String = row.get(4)?;
    let outcome: Option<String> = row.get(7)?;
    let check = DeliveryCheck {
        id: row.get(0)?,
        project_id: row.get(1)?,
        ticket_id: row.get(2)?,
        step_id: row.get(3)?,
        reason: DeliveryCheckReason::parse(&reason).ok_or_else(|| invalid(4))?,
        started_at_epoch_ms: row.get(5)?,
        finished_at_epoch_ms: row.get(6)?,
        outcome: match outcome {
            Some(outcome) => Some(DeliveryCheckOutcome::parse(&outcome).ok_or_else(|| invalid(7))?),
            None => None,
        },
    };
    if check.is_valid() {
        Ok(check)
    } else {
        Err(invalid(0))
    }
}

pub(crate) fn check_by_id(
    connection: &Connection,
    check_id: &str,
) -> Result<Option<DeliveryCheck>, PmError> {
    Ok(connection
        .query_row(
            &format!("SELECT {CHECK_COLUMNS} FROM delivery_checks WHERE id = ?1"),
            [check_id],
            check_row,
        )
        .optional()?)
}

/// The ticket's running check, if any.
pub(crate) fn running_check(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Option<DeliveryCheck>, PmError> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT {CHECK_COLUMNS} FROM delivery_checks \
                 WHERE ticket_id = ?1 AND finished_at_epoch_ms IS NULL"
            ),
            [ticket_id],
            check_row,
        )
        .optional()?)
}

fn checks_where(
    connection: &Connection,
    filter: &str,
    parameter: &str,
) -> Result<Vec<DeliveryCheck>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {CHECK_COLUMNS} FROM delivery_checks WHERE {filter} \
         ORDER BY started_at_epoch_ms, id"
    ))?;
    let checks = statement
        .query_map([parameter], check_row)?
        .collect::<Result<_, _>>()?;
    Ok(checks)
}

/// A project's running checks, oldest first.
pub(crate) fn project_running_checks(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<DeliveryCheck>, PmError> {
    checks_where(
        connection,
        "project_id = ?1 AND finished_at_epoch_ms IS NULL",
        project_id,
    )
}

/// Every check of a project still kept, oldest first.
pub(crate) fn project_checks(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<DeliveryCheck>, PmError> {
    checks_where(connection, "project_id = ?1", project_id)
}

/// Every running check across projects, oldest first.
pub(crate) fn all_running_checks(connection: &Connection) -> Result<Vec<DeliveryCheck>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {CHECK_COLUMNS} FROM delivery_checks WHERE finished_at_epoch_ms IS NULL \
         ORDER BY started_at_epoch_ms, id"
    ))?;
    let checks = statement
        .query_map([], check_row)?
        .collect::<Result<_, _>>()?;
    Ok(checks)
}
