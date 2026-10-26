//! Reads of the Playbook tables: a project's steps, the stored verdicts of
//! its tickets, and a waiting setup proposal.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row};

use super::delivery_rows::{invalid_row, json_column};
use super::rows::parsed;
use crate::PmError;
use crate::playbook::{
    Playbook, PlaybookProposal, StepEvaluator, StepVerdict, StepVerdictRecord,
    valid_playbook_steps, valid_playbook_summary, valid_step_evidence,
};

/// The project's Playbook; the default steps when it never saved one.
pub(crate) fn project_playbook(
    connection: &Connection,
    project_id: &str,
) -> Result<Playbook, PmError> {
    let stored = connection
        .query_row(
            "SELECT revision, steps_json, updated_at_epoch_ms FROM playbooks \
             WHERE project_id = ?1",
            [project_id],
            |row| {
                let playbook = Playbook {
                    project_id: project_id.to_owned(),
                    revision: row.get(0)?,
                    steps: json_column(row, 1)?,
                    updated_at_epoch_ms: row.get(2)?,
                };
                if valid_playbook_steps(&playbook.steps) {
                    Ok(playbook)
                } else {
                    Err(invalid_row(1))
                }
            },
        )
        .optional()?;
    Ok(stored.unwrap_or_else(|| Playbook::default_for(project_id)))
}

const VERDICT_COLUMNS: &str = "v.ticket_id, v.step_id, v.verdict, v.evidence, v.evaluator, \
     v.decided_at_epoch_ms, v.next_attempt_at_epoch_ms";

fn verdict_row(row: &Row<'_>) -> rusqlite::Result<StepVerdictRecord> {
    let record = StepVerdictRecord {
        ticket_id: row.get(0)?,
        step_id: row.get(1)?,
        verdict: parsed(row, 2, StepVerdict::parse)?,
        evidence: row.get(3)?,
        evaluator: parsed(row, 4, StepEvaluator::parse)?,
        decided_at_epoch_ms: row.get(5)?,
        next_attempt_at_epoch_ms: row.get(6)?,
    };
    if valid_step_evidence(&record.evidence) && record.evaluator != StepEvaluator::Facts {
        Ok(record)
    } else {
        Err(invalid_row(3))
    }
}

/// The stored verdicts of every ticket of a project, by ticket id.
pub(crate) fn project_verdicts(
    connection: &Connection,
    project_id: &str,
) -> Result<HashMap<String, Vec<StepVerdictRecord>>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {VERDICT_COLUMNS} FROM playbook_verdicts v \
         JOIN tickets t ON t.id = v.ticket_id WHERE t.project_id = ?1 \
         ORDER BY v.ticket_id, v.step_id"
    ))?;
    let mut verdicts: HashMap<String, Vec<StepVerdictRecord>> = HashMap::new();
    for record in statement.query_map([project_id], verdict_row)? {
        let record = record?;
        verdicts
            .entry(record.ticket_id.clone())
            .or_default()
            .push(record);
    }
    Ok(verdicts)
}

/// The stored verdicts of one ticket.
pub(crate) fn ticket_verdicts(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Vec<StepVerdictRecord>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {VERDICT_COLUMNS} FROM playbook_verdicts v WHERE v.ticket_id = ?1 \
         ORDER BY v.step_id"
    ))?;
    let verdicts = statement
        .query_map([ticket_id], verdict_row)?
        .collect::<Result<_, _>>()?;
    Ok(verdicts)
}

pub(crate) fn playbook_proposal(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<PlaybookProposal>, PmError> {
    Ok(connection
        .query_row(
            "SELECT summary, steps_json, created_at_epoch_ms FROM playbook_proposals \
             WHERE project_id = ?1",
            [project_id],
            |row| {
                let proposal = PlaybookProposal {
                    project_id: project_id.to_owned(),
                    summary: row.get(0)?,
                    steps: json_column(row, 1)?,
                    created_at_epoch_ms: row.get(2)?,
                };
                if valid_playbook_summary(&proposal.summary)
                    && valid_playbook_steps(&proposal.steps)
                {
                    Ok(proposal)
                } else {
                    Err(invalid_row(1))
                }
            },
        )
        .optional()?)
}
