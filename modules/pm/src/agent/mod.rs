//! The PM's agent: one role with four modes, the ticket tools it reaches over
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
pub use profile::{AssistantTask, PM_SYSTEM_PROMPT_MAX_BYTES, PmAgentProfile, SkillRunBrief};
pub use tools::{
    AcceptanceCriteriaProposalParams, AgentProbeParams, BoardReadParams, BoardReadResult,
    BoardScope, BoardSprint, BoardTicket, CheckReportParams, CheckReportResult,
    DescriptionProposalParams, NoteAddParams, NoteAddResult, PmToolContext, PmToolDefinition,
    PmToolError, ProbeProposalParams, ProposalResult, ReportedEnvironmentParams, RisksReadParams,
    RisksReadResult, SkillDraftSubmitParams, SkillRunContext, SkillRunFinishParams, SuggestParams,
    TicketReadParams, TicketReadResult, TicketRisks, call_pm_tool, pm_tool_access,
    pm_tool_definitions,
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
    /// One run of an installed skill, or a draft's dry run: it reads with
    /// the skill's approved tools only and suggests through proposals.
    SkillRun,
    /// The interactive skill creator: read-only discovery of the PM's
    /// sources and tools, verified, and skill drafts the PM reviews.
    SkillCreator,
}

pub const PM_BOARD_READ: &str = "pm_board_read";
pub const PM_TICKET_READ: &str = "pm_ticket_read";
pub const PM_TICKET_PROPOSE_DESCRIPTION: &str = "pm_ticket_propose_description";
pub const PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA: &str = "pm_ticket_propose_acceptance_criteria";
pub const PM_RISKS_READ: &str = "pm_risks_read";
pub const PM_CHECK_REPORT: &str = "pm_check_report";
pub const PM_TICKET_SUGGEST: &str = "pm_ticket_suggest";
pub const PM_SKILL_RUN_FINISH: &str = "pm_skill_run_finish";
pub const PM_SKILL_DISCOVERY_READ: &str = "pm_skill_discovery_read";
pub const PM_SKILL_TOOL_VERIFY: &str = "pm_skill_tool_verify";
pub const PM_SKILL_DRAFT_SUBMIT: &str = "pm_skill_draft_submit";
pub const PM_SKILL_DRY_RUN_REQUEST: &str = "pm_skill_dry_run_request";
pub const PM_TICKET_NOTE_ADD: &str = "pm_ticket_note_add";

/// The read tools a skill manifest may approve. A run sees exactly the
/// ones its manifest approved, plus [`SKILL_PROPOSAL_TOOLS`].
pub const SKILL_READ_TOOLS: &[&str] = &[PM_BOARD_READ, PM_TICKET_READ, PM_RISKS_READ];

/// What every skill run may call: proposals and its one closing report.
pub const SKILL_PROPOSAL_TOOLS: &[&str] = &[
    PM_TICKET_PROPOSE_DESCRIPTION,
    PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
    PM_TICKET_SUGGEST,
    PM_SKILL_RUN_FINISH,
];

/// Tools the daemon answers itself because they need I/O beyond the PM
/// store: discovery, verification, and launching a dry run.
pub const PM_HOST_TOOLS: &[&str] = &[
    PM_SKILL_DISCOVERY_READ,
    PM_SKILL_TOOL_VERIFY,
    PM_SKILL_DRY_RUN_REQUEST,
];

/// Every PM agent tool.
pub const PM_TOOLS: &[&str] = &[
    PM_BOARD_READ,
    PM_TICKET_READ,
    PM_TICKET_PROPOSE_DESCRIPTION,
    PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
    PM_RISKS_READ,
    PM_CHECK_REPORT,
    PM_TICKET_SUGGEST,
    PM_SKILL_RUN_FINISH,
    PM_SKILL_DISCOVERY_READ,
    PM_SKILL_TOOL_VERIFY,
    PM_SKILL_DRAFT_SUBMIT,
    PM_SKILL_DRY_RUN_REQUEST,
    PM_TICKET_NOTE_ADD,
];

impl PmAgentMode {
    /// The tools this mode may call; any other tool is denied. A skill
    /// run narrows this further to its manifest (see
    /// [`PmToolContext::tools`]).
    pub const fn tools(self) -> &'static [&'static str] {
        match self {
            Self::Assistant => &[
                PM_BOARD_READ,
                PM_TICKET_READ,
                PM_TICKET_PROPOSE_DESCRIPTION,
                PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
                PM_RISKS_READ,
                PM_TICKET_NOTE_ADD,
            ],
            Self::DeliveryCheck => &[
                PM_BOARD_READ,
                PM_TICKET_READ,
                PM_TICKET_PROPOSE_DESCRIPTION,
                PM_RISKS_READ,
                PM_CHECK_REPORT,
            ],
            Self::SkillRun => &[
                PM_BOARD_READ,
                PM_TICKET_READ,
                PM_RISKS_READ,
                PM_TICKET_PROPOSE_DESCRIPTION,
                PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
                PM_TICKET_SUGGEST,
                PM_SKILL_RUN_FINISH,
            ],
            Self::SkillCreator => &[
                PM_BOARD_READ,
                PM_TICKET_READ,
                PM_RISKS_READ,
                PM_SKILL_DISCOVERY_READ,
                PM_SKILL_TOOL_VERIFY,
                PM_SKILL_DRAFT_SUBMIT,
                PM_SKILL_DRY_RUN_REQUEST,
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
            Self::SkillRun => "skillRun",
            Self::SkillCreator => "skillCreator",
        }
    }
}

#[cfg(test)]
mod tests;
