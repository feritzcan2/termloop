//! The ticket tools the PM agent calls over MCP. Each tool has typed
//! parameters and result, a JSON Schema (see `schema`), and a handler over
//! [`PmStore`]. The daemon authenticates the agent and supplies its
//! [`PmToolContext`]; this module decides what that context may do.
//!
//! Tools read the PM store and write only PM-store proposals, ticket
//! notes, check reports, skill drafts, skill run reports, Playbook
//! proposals, and epic breakdowns. None writes Jira, a Git
//! host, or any other external system. Host tools ([`PM_HOST_TOOLS`]) are
//! defined here but answered by the daemon.

mod handlers;
mod schema;

use serde_json::Value;

pub use handlers::{
    AcceptanceCriteriaProposalParams, BoardEpic, BoardReadParams, BoardReadResult, BoardScope,
    BoardSprint, BoardTicket, BreakdownProposeParams, BreakdownProposeResult, CheckReportParams,
    CheckReportResult, DescriptionProposalParams, NoteAddParams, NoteAddResult,
    PlaybookProposeParams, ProposalResult, RisksReadParams, RisksReadResult,
    SkillDraftSubmitParams, SkillRunFinishParams, SuggestParams, TicketReadParams,
    TicketReadResult, TicketRisks,
};
pub use schema::{PmToolDefinition, pm_tool_definitions};

use super::{
    PM_BOARD_READ, PM_CHECK_REPORT, PM_EPIC_PROPOSE_BREAKDOWN, PM_HOST_TOOLS, PM_PLAYBOOK_PROPOSE,
    PM_RISKS_READ, PM_SKILL_DRAFT_SUBMIT, PM_SKILL_RUN_FINISH, PM_TICKET_NOTE_ADD,
    PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA, PM_TICKET_PROPOSE_DESCRIPTION, PM_TICKET_READ,
    PM_TICKET_SUGGEST, PM_TOOLS, PmAgentMode, SKILL_PROPOSAL_TOOLS,
};
use crate::{PmError, PmStore};

/// Who is calling: the project and mode the daemon launched the agent for.
/// A delivery check is bound to the one ticket it checks; a skill run to
/// its run and the tools its manifest approved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PmToolContext {
    pub project_id: String,
    pub mode: PmAgentMode,
    /// The ticket in focus; required for a delivery check.
    pub ticket_id: Option<String>,
    /// Required for a skill run.
    pub skill: Option<SkillRunContext>,
}

/// The run a skill-run agent works for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRunContext {
    pub run_id: String,
    /// The installed skill and its manifest version; `None` in a dry run.
    pub skill: Option<(String, u32)>,
    /// The draft of a dry run; its suggestions become samples.
    pub draft_id: Option<String>,
    /// The read tools the manifest approved.
    pub approved_tools: Vec<String>,
}

impl PmToolContext {
    pub fn new(project_id: impl Into<String>, mode: PmAgentMode) -> Self {
        Self {
            project_id: project_id.into(),
            mode,
            ticket_id: None,
            skill: None,
        }
    }

    /// The tools this caller may list and call: the mode's, narrowed for a
    /// skill run to its approved read tools and the proposal tools.
    pub fn tools(&self) -> Vec<&'static str> {
        let mode = self.mode.tools().iter().copied();
        match (self.mode, &self.skill) {
            (PmAgentMode::SkillRun, Some(run)) => mode
                .filter(|tool| {
                    SKILL_PROPOSAL_TOOLS.contains(tool)
                        || run.approved_tools.iter().any(|approved| approved == tool)
                })
                .collect(),
            (PmAgentMode::SkillRun, None) => Vec::new(),
            _ => mode.collect(),
        }
    }

    pub fn allows(&self, tool: &str) -> bool {
        self.tools().contains(&tool)
    }
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

/// The tool a caller may run under this name: an unknown tool, or one the
/// context does not allow, is refused before its arguments are read.
pub fn pm_tool_access(context: &PmToolContext, name: &str) -> Result<&'static str, PmToolError> {
    let Some(tool) = PM_TOOLS.iter().copied().find(|tool| *tool == name) else {
        return Err(PmToolError::UnknownTool(name.chars().take(64).collect()));
    };
    if !context.allows(tool) {
        return Err(denied(tool, "not available in this mode"));
    }
    if context.mode == PmAgentMode::DeliveryCheck && context.ticket_id.is_none() {
        return Err(denied(tool, "a delivery check needs its ticket"));
    }
    Ok(tool)
}

/// Runs one tool call that the PM store answers. Host tools are the
/// daemon's to answer; here they are refused.
pub fn call_pm_tool(
    store: &mut PmStore,
    context: &PmToolContext,
    name: &str,
    arguments: Value,
) -> Result<Value, PmToolError> {
    let tool = pm_tool_access(context, name)?;
    if PM_HOST_TOOLS.contains(&tool) {
        return Err(denied(tool, "answered by the PM daemon"));
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
        PM_TICKET_SUGGEST => result(handlers::suggest(store, context, parse(arguments)?)?),
        PM_SKILL_RUN_FINISH => result(handlers::skill_run_finish(
            store,
            context,
            parse(arguments)?,
        )?),
        PM_SKILL_DRAFT_SUBMIT => result(handlers::draft_submit(store, context, parse(arguments)?)?),
        PM_TICKET_NOTE_ADD => result(handlers::note_add(store, context, parse(arguments)?)?),
        PM_PLAYBOOK_PROPOSE => result(handlers::playbook_propose(
            store,
            context,
            parse(arguments)?,
        )?),
        PM_EPIC_PROPOSE_BREAKDOWN => result(handlers::breakdown_propose(
            store,
            context,
            parse(arguments)?,
        )?),
        _ => Err(PmToolError::UnknownTool(name.to_owned())),
    }
}

#[cfg(test)]
mod tests;
