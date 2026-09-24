/// A product supplies its own visible template and authority. Provider argument
/// syntax and the private payload remain owned by the launch package.
pub struct LaunchRequest<'a> {
    pub agent_id: &'a str,
    pub cwd: &'a str,
    pub template: &'a PromptTemplate,
    pub model: &'a str,
    pub permission: &'a str,
    pub reasoning: &'a str,
    pub prompt: Option<&'a str>,
    pub conversation: AgentConversationLaunch<'a>,
    pub observation: Option<AgentObservationLaunch<'a>>,
    pub mcp: Option<McpConnection<'a>>,
    pub provider_instructions_source: Option<&'a PromptTemplate>,
    pub provider_instructions: Option<&'a str>,
    pub attachments: &'a [ImageAttachment],
    pub codex_project_trust: CodexProjectTrust,
    pub executable_directory: Option<&'a Path>,
    pub explicit_configuration: bool,
    pub execution: Option<CodexExecutionPolicy>,
    /// Explicit policy for the provider workspace-write sandbox; None inherits its configuration.
    pub workspace_network: Option<bool>,
    pub approved_tools: &'a [&'a str],
}

impl<'a> LaunchRequest<'a> {
    pub fn interactive(agent_id: &'a str, cwd: &'a str, template: &'a PromptTemplate) -> Self {
        Self {
            agent_id,
            cwd,
            template,
            model: "default",
            permission: "default",
            reasoning: "default",
            prompt: None,
            conversation: AgentConversationLaunch::Fresh { resume_ref: None },
            observation: None,
            mcp: None,
            provider_instructions_source: None,
            provider_instructions: None,
            attachments: &[],
            codex_project_trust: CodexProjectTrust::Inherit,
            executable_directory: None,
            explicit_configuration: false,
            execution: None,
            workspace_network: None,
            approved_tools: &[],
        }
    }
}

#[derive(Clone, Copy)]
pub struct McpConnection<'a> {
    pub endpoint: &'a str,
    pub token: &'a str,
    pub claude_config_path: &'a str,
    pub server_name: &'a str,
    pub instructions: Option<&'a PromptTemplate>,
}

/// Noninteractive execution is deliberately explicit; it never inherits the
/// interactive user's plugin, hook, or rules configuration.
#[derive(Clone, Copy)]
pub struct CodexExecutionPolicy {
    pub sandbox: CodexSandbox,
    pub network: bool,
    pub web_search: bool,
}

#[derive(Clone, Copy)]
pub enum CodexSandbox {
    ReadOnly,
    WorkspaceWrite,
}

/// Daemon-private provider identity; Debug and public manifests never reveal it.
#[derive(Clone)]
pub struct ConversationHandle(termloop_domain::ResumeRef);
impl ConversationHandle {
    pub fn from_native(provider: &str, identity: String) -> Result<Self, InvocationError> {
        let provider = match provider {
            "claude" => termloop_domain::ResumeProvider::Claude,
            "codex" => termloop_domain::ResumeProvider::Codex,
            "gemini" => termloop_domain::ResumeProvider::Gemini,
            _ => return Err(InvocationError::UnsupportedAgent(provider.into())),
        };
        termloop_domain::ResumeRef::for_provider(provider, identity)
            .map(Self)
            .ok_or(InvocationError::InvalidResumeReference)
    }
    pub fn resume(&self) -> AgentConversationLaunch<'_> {
        AgentConversationLaunch::Resume {
            resume_ref: &self.0,
        }
    }
    pub fn fork(&self) -> AgentConversationLaunch<'_> {
        AgentConversationLaunch::Fork {
            source_ref: &self.0,
        }
    }
}
impl std::fmt::Debug for ConversationHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ConversationHandle(<private>)")
    }
}

/// The same explicit product tool/network policy must reach the execution
/// server on both fresh and resumed remote TUI connections.
#[derive(Clone, Default)]
pub struct CodexRuntimePolicy {
    pub approved_tools: Vec<String>,
    pub workspace_network: Option<bool>,
}
