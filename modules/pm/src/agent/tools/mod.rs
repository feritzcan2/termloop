//! The ticket tools the PM agent calls over MCP. Each tool has typed
//! parameters and result, a JSON Schema (see `schema`), and a handler over
//! [`PmStore`]. The daemon authenticates the agent and supplies its
//! [`PmToolContext`]; this module decides what that context may do.
//!
//! Tools read the PM store and write only PM-store proposals and check
//! reports. None writes Jira, a Git host, or any other external system.

mod handlers;
mod schema;

use serde_json::Value;

pub use handlers::{
    AcceptanceCriteriaProposalParams, AgentProbeParams, BoardReadParams, BoardReadResult,
    BoardScope, BoardSprint, BoardTicket, CheckReportParams, CheckReportResult,
    DescriptionProposalParams, ProbeProposalParams, ProposalResult, ReportedEnvironmentParams,
    RisksReadParams, RisksReadResult, TicketReadParams, TicketReadResult, TicketRisks,
};
pub use schema::{PmToolDefinition, pm_tool_definitions};

use super::{
    PM_BOARD_READ, PM_CHECK_REPORT, PM_RISKS_READ, PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
    PM_TICKET_PROPOSE_DESCRIPTION, PM_TICKET_READ, PM_TOOLS, PmAgentMode,
};
use crate::{PmError, PmStore};

/// Who is calling: the project and mode the daemon launched the agent for.
/// A delivery check is bound to the one ticket it checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PmToolContext {
    pub project_id: String,
    pub mode: PmAgentMode,
    /// The ticket in focus; required for a delivery check.
    pub ticket_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum PmToolError {
    #[error("unknown tool {0}")]
    UnknownTool(String),
    /// The tool, or the ticket it names, is outside the caller's mode.
    #[error("{tool} is denied: {reason}")]
    Denied { tool: String, reason: &'static str },
    #[error("invalid arguments: {0}")]
    InvalidArguments(String),
    #[error(transparent)]
    Store(#[from] PmError),
}

impl PmToolError {
    /// A stable code for the MCP error result.
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownTool(_) => "unknownTool",
            Self::Denied { .. } => "denied",
            Self::InvalidArguments(_) | Self::Store(PmError::Invalid(_)) => "invalidArguments",
            Self::Store(PmError::NotFound) => "notFound",
            Self::Store(PmError::Conflict) => "conflict",
            Self::Store(PmError::Constraint(_)) => "refused",
            Self::Store(_) => "failed",
        }
    }
}

fn denied(tool: &str, reason: &'static str) -> PmToolError {
    PmToolError::Denied {
        tool: tool.to_owned(),
        reason,
    }
}

fn parse<T: serde::de::DeserializeOwned>(arguments: Value) -> Result<T, PmToolError> {
    let arguments = if arguments.is_null() {
        Value::Object(Default::default())
    } else {
        arguments
    };
    serde_json::from_value(arguments)
        .map_err(|error| PmToolError::InvalidArguments(error.to_string()))
}

fn result<T: serde::Serialize>(value: T) -> Result<Value, PmToolError> {
    serde_json::to_value(value)
        .map_err(|error| PmToolError::Store(PmError::Storage(error.to_string())))
}

/// Runs one tool call: an unknown tool, or one the context's mode does not
/// allow, is refused before its arguments are read.
pub fn call_pm_tool(
    store: &mut PmStore,
    context: &PmToolContext,
    name: &str,
    arguments: Value,
) -> Result<Value, PmToolError> {
    let Some(tool) = PM_TOOLS.iter().copied().find(|tool| *tool == name) else {
        return Err(PmToolError::UnknownTool(name.chars().take(64).collect()));
    };
    if !context.mode.allows(tool) {
        return Err(denied(tool, "not available in this mode"));
    }
    if context.mode == PmAgentMode::DeliveryCheck && context.ticket_id.is_none() {
        return Err(denied(tool, "a delivery check needs its ticket"));
    }
    match tool {
        PM_BOARD_READ => result(handlers::board_read(store, context, parse(arguments)?)?),
        PM_TICKET_READ => result(handlers::ticket_read(store, context, parse(arguments)?)?),
        PM_TICKET_PROPOSE_DESCRIPTION => result(handlers::propose_description(
            store,
            context,
            parse(arguments)?,
        )?),
        PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA => result(handlers::propose_acceptance_criteria(
            store,
            context,
            parse(arguments)?,
        )?),
        PM_RISKS_READ => result(handlers::risks_read(store, context, parse(arguments)?)?),
        PM_CHECK_REPORT => result(handlers::check_report(store, context, parse(arguments)?)?),
        _ => Err(PmToolError::UnknownTool(name.to_owned())),
    }
}

#[cfg(test)]
mod tests;
