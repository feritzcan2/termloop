#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provenance {
    pub template_ref: String,
    pub template_version: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct PromptTemplate {
    pub id: &'static str,
    pub version: u32,
    pub authored_body: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageAttachment {
    pub attachment_id: String,
    pub file_path: String,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum InvocationError {
    #[error("launch payload has no visible template provenance")]
    UnprovenancedPrompt,
    #[error("launch template is missing from the visible catalog")]
    TemplateMissing,
    #[error("unsupported agent: {0}")]
    UnsupportedAgent(String),
    #[error("agent CLI for {0} was not found on the launch PATH")]
    AgentCliNotFound(String),
    #[error("agent CLI for {0} exists but cannot be launched")]
    AgentCliUnusable(String),
    #[error("private resume reference is invalid for the selected provider")]
    InvalidResumeReference,
    #[error("Codex App Server runtime binding is invalid")]
    InvalidRuntimeBinding,
    #[error("quick action prompt is empty or exceeds its limit")]
    InvalidPrompt,
    #[error("Quick Action image attachment is invalid")]
    InvalidImageAttachment,
    #[error("unsupported model {model} for agent {agent_id}")]
    UnsupportedModel { agent_id: String, model: String },
    #[error("unsupported permission {permission} for agent {agent_id}")]
    UnsupportedPermission {
        agent_id: String,
        permission: String,
    },
    #[error("unsupported reasoning {reasoning} for agent {agent_id}")]
    UnsupportedReasoning { agent_id: String, reasoning: String },
    #[error("local MCP endpoint is invalid")]
    InvalidMcpEndpoint,
    #[error("observation transport does not belong to the selected agent")]
    InvalidObservationTransport,
    #[error("provider configuration already owns the launch-scoped observation layer")]
    ObservationConfigurationConflict,
    #[error("developer instructions cannot be represented in provider configuration")]
    InvalidDeveloperInstructions,
    #[error("visible prompt binding is invalid")]
    InvalidPromptBinding,
    #[error("assistant launch or wake configuration is invalid")]
    InvalidAssistantConfiguration,
}
