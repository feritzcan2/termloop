//! Recording what one read of Jira or the Git host observed about a
//! ticket's delivery.

use rusqlite::{Connection, params};

use super::require_ticket;
use crate::delivery::facts::{
    FactSource, JiraStatusCategory, PullRequestFact, TicketDeliveryFacts,
};
use crate::store::{ticket_facts, to_json};
use crate::{PmError, PmStore};

/// The outcome of one read of an external source.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum FactRead<T> {
    /// The source was not read this time; its last facts stay as they are.
    #[default]
    NotRead,
    Read(T),
    /// The read failed with a stable reason code such as `unauthorized`.
    /// The last good facts stay, beside the reason.
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraObservation {
    pub status: String,
    pub status_category: Option<JiraStatusCategory>,
    pub assignee: Option<String>,
    pub updated_at_epoch_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestsObservation {
    /// A secret-free repository label such as `github.com/owner/repo`.
    pub repository: String,
    pub items: Vec<PullRequestFact>,
    pub truncated: bool,
}

/// Everything one delivery refresh observed about a ticket.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FactsObservation {
    pub jira: FactRead<JiraObservation>,
    pub pull_requests: FactRead<PullRequestsObservation>,
}

/// Replaces a ticket's facts record after validating it.
pub(crate) fn store_facts(
    connection: &Connection,
    facts: &TicketDeliveryFacts,
) -> Result<(), PmError> {
    if !facts.is_valid() {
        return Err(PmError::Invalid("facts"));
    }
    connection.execute(
        "INSERT INTO ticket_delivery_facts (ticket_id, facts_json, recorded_at_epoch_ms) \
         VALUES (?1, ?2, ?3) \
         ON CONFLICT (ticket_id) DO UPDATE SET \
             facts_json = excluded.facts_json, \
             recorded_at_epoch_ms = excluded.recorded_at_epoch_ms",
        params![facts.ticket_id, to_json(facts)?, facts.recorded_at_epoch_ms],
    )?;
    Ok(())
}

/// A ticket's current facts, or an empty record for it.
pub(crate) fn current_facts(
    connection: &Connection,
    ticket_id: &str,
) -> Result<TicketDeliveryFacts, PmError> {
    Ok(ticket_facts(connection, ticket_id)?.unwrap_or_else(|| TicketDeliveryFacts::new(ticket_id)))
}

impl PmStore {
    /// Records one delivery refresh of a ticket. Each source read replaces
    /// its fact (keeping change times when nothing changed); a failed read
    /// keeps the last good fact and records why. The whole record is
    /// validated before it is stored, so an invalid observation changes
    /// nothing.
    pub fn record_facts(
        &mut self,
        ticket_id: &str,
        observation: FactsObservation,
    ) -> Result<TicketDeliveryFacts, PmError> {
        let now = self.now();
        self.write(|transaction| {
            require_ticket(transaction, ticket_id)?;
            let mut facts = current_facts(transaction, ticket_id)?;
            match observation.jira {
                FactRead::NotRead => {}
                FactRead::Read(jira) => facts.observe_jira(
                    jira.status,
                    jira.status_category,
                    jira.assignee,
                    jira.updated_at_epoch_ms,
                    now,
                ),
                FactRead::Failed(reason) => facts.fail_read(FactSource::Jira, reason, now),
            }
            match observation.pull_requests {
                FactRead::NotRead => {}
                FactRead::Read(read) => {
                    facts.observe_pull_requests(read.repository, read.items, read.truncated, now)
                }
                FactRead::Failed(reason) => facts.fail_read(FactSource::GitHost, reason, now),
            }
            facts.recorded_at_epoch_ms = now;
            store_facts(transaction, &facts)?;
            Ok(facts)
        })
    }
}
