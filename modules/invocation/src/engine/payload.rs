#[derive(Clone, Copy)]
pub struct AgentMcpLaunch<'a> {
    pub endpoint: &'a str,
    pub token: &'a str,
    pub claude_config_path: &'a str,
    pub profile: AgentMcpProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentMcpProfile {
    Interactive,
    /// An ordinary interactive Agent in a Project opened as Project Manager. It
    /// keeps the Interactive MCP authority; only its visible instructions differ.
    ProjectManager,
    Improver,
    Steward,
    Helper,
    PlaybookEvaluator,
}

impl AgentMcpProfile {
    /// The visible session-protocol template an Agent of this profile runs
    /// under, if any.
    pub(crate) fn interactive_instructions(self) -> Option<&'static PromptTemplate> {
        match self {
            Self::Interactive | Self::Improver => Some(&INTERACTIVE_AGENT_TEMPLATE),
            Self::ProjectManager => Some(&PROJECT_MANAGER_AGENT_TEMPLATE),
            Self::Steward | Self::Helper | Self::PlaybookEvaluator => None,
        }
    }
}

impl<'a> AgentMcpLaunch<'a> {
    pub fn connection(self) -> termloop_launch::McpConnection<'a> {
        termloop_launch::McpConnection {
            endpoint: self.endpoint,
            token: self.token,
            claude_config_path: self.claude_config_path,
            server_name: "termloop_next",
            instructions: self.profile.interactive_instructions(),
        }
    }
}
