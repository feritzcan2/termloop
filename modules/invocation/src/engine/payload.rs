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
    Improver,
    Steward,
    Helper,
}

impl AgentMcpProfile {
    fn includes_interactive_instructions(self) -> bool {
        matches!(self, Self::Interactive | Self::Improver)
    }
}

impl<'a> AgentMcpLaunch<'a> {
    pub fn connection(self) -> termloop_launch::McpConnection<'a> {
        termloop_launch::McpConnection {
            endpoint: self.endpoint,
            token: self.token,
            claude_config_path: self.claude_config_path,
            server_name: "termloop_next",
            instructions: self.profile.includes_interactive_instructions().then_some(&INTERACTIVE_AGENT_TEMPLATE),
        }
    }
}
