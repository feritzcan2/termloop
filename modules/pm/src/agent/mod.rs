//! The PM's agent: one role with two modes, the ticket tools it reaches over
//! MCP, and the plan for launching it. Nothing here spawns a process, opens a
//! socket, or reads a credential: the PM daemon does that with what is built
//! here. No agent tool writes Jira or any other external system.

mod launch;
mod profile;
mod tools;

pub use launch::{
    PM_MCP_SERVER_NAME, PmLaunchError, PmLaunchPlan, PmLaunchRequest, claude_mcp_config,
    pm_launch_plan,
};
pub use profile::{PM_SYSTEM_PROMPT_MAX_BYTES, PmAgentProfile};
pub use tools::{
    AcceptanceCriteriaProposalParams, AgentProbeParams, BoardReadParams, BoardReadResult,
    BoardScope, BoardSprint, BoardTicket, CheckReportParams, CheckReportResult,
    DescriptionProposalParams, PmToolContext, PmToolDefinition, PmToolError, ProbeProposalParams,
    ProposalResult, ReportedEnvironmentParams, RisksReadParams, RisksReadResult, TicketReadParams,
    TicketReadResult, TicketRisks, call_pm_tool, pm_tool_definitions,
};

/// What the PM agent is launched for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PmAgentMode {
    /// The PM's interactive agent in a terminal.
    Assistant,
    /// A short-lived, non-interactive agent that finds out where one
    /// ticket's change runs, reports once, and stops.
    DeliveryCheck,
}

pub const PM_BOARD_READ: &str = "pm_board_read";
pub const PM_TICKET_READ: &str = "pm_ticket_read";
pub const PM_TICKET_PROPOSE_DESCRIPTION: &str = "pm_ticket_propose_description";
pub const PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA: &str = "pm_ticket_propose_acceptance_criteria";
pub const PM_RISKS_READ: &str = "pm_risks_read";
pub const PM_CHECK_REPORT: &str = "pm_check_report";

/// Every PM agent tool.
pub const PM_TOOLS: &[&str] = &[
    PM_BOARD_READ,
    PM_TICKET_READ,
    PM_TICKET_PROPOSE_DESCRIPTION,
    PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
    PM_RISKS_READ,
    PM_CHECK_REPORT,
];

impl PmAgentMode {
    /// The tools this mode may call; any other tool is denied.
    pub const fn tools(self) -> &'static [&'static str] {
        match self {
            Self::Assistant => &[
                PM_BOARD_READ,
                PM_TICKET_READ,
                PM_TICKET_PROPOSE_DESCRIPTION,
                PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
                PM_RISKS_READ,
            ],
            Self::DeliveryCheck => &[
                PM_BOARD_READ,
                PM_TICKET_READ,
                PM_TICKET_PROPOSE_DESCRIPTION,
                PM_RISKS_READ,
                PM_CHECK_REPORT,
            ],
        }
    }

    pub fn allows(self, tool: &str) -> bool {
        self.tools().contains(&tool)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Assistant => "assistant",
            Self::DeliveryCheck => "deliveryCheck",
        }
    }
}

#[cfg(test)]
mod tests;
