//! The launch plan of the PM agent: Claude or Codex, its system prompt, the
//! PM MCP server registration, and which PM tools run without asking. The
//! provider argument syntax and the private payload stay owned by
//! `termloop-launch`; this module only fills in the PM's part.
//!
//! The daemon supplies the MCP endpoint and bearer token. The token is only
//! handed to `termloop-launch`, which places it in the child's environment
//! (`TERMLOOP_MCP_TOKEN`), never in argv. Nothing here generates, logs, or
//! persists it.

use termloop_launch::{
    AgentConversationLaunch, AgentObservationLaunch, InvocationError, LaunchPayload, LaunchRequest,
    McpConnection, PromptTemplate, resolve,
};

use super::PmAgentMode;
use super::profile::{ASSISTANT_TEMPLATE, DELIVERY_CHECK_TEMPLATE, PmAgentProfile};

/// The MCP server name the PM tools are registered under.
pub const PM_MCP_SERVER_NAME: &str = "termloop_pm";
/// The environment variable the bearer token reaches the agent through.
const MCP_TOKEN_ENV: &str = "TERMLOOP_MCP_TOKEN";
const TOKEN_MAX_BYTES: usize = 4 * 1024;

/// What the daemon decides for one launch.
pub struct PmLaunchRequest<'a> {
    /// `claude` or `codex`.
    pub agent_id: &'a str,
    pub cwd: &'a str,
    pub model: &'a str,
    pub permission: &'a str,
    pub reasoning: &'a str,
    pub profile: &'a PmAgentProfile,
    /// The daemon's loopback HTTP MCP endpoint for this agent.
    pub mcp_endpoint: &'a str,
    /// The bearer the daemon issued for this agent. Never in argv.
    pub mcp_token: &'a str,
    /// Where the daemon wrote [`claude_mcp_config`] privately; Claude only.
    pub claude_mcp_config_path: &'a str,
    /// The assistant may resume an earlier conversation; a delivery check
    /// always starts fresh.
    pub conversation: AgentConversationLaunch<'a>,
    pub observation: Option<AgentObservationLaunch<'a>>,
    /// Test seam: where the agent CLI is looked up instead of the PATH.
    pub executable_directory: Option<&'a std::path::Path>,
}

impl<'a> PmLaunchRequest<'a> {
    /// A fresh launch with the provider's default selection.
    pub fn new(
        agent_id: &'a str,
        cwd: &'a str,
        profile: &'a PmAgentProfile,
        mcp_endpoint: &'a str,
        mcp_token: &'a str,
        claude_mcp_config_path: &'a str,
    ) -> Self {
        Self {
            agent_id,
            cwd,
            model: "default",
            permission: "default",
            reasoning: "default",
            profile,
            mcp_endpoint,
            mcp_token,
            claude_mcp_config_path,
            conversation: AgentConversationLaunch::Fresh { resume_ref: None },
            observation: None,
            executable_directory: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PmLaunchError {
    #[error("the PM agent runs on Claude or Codex only")]
    UnsupportedAgent,
    #[error("the PM MCP endpoint must be a loopback http URL")]
    InvalidEndpoint,
    #[error("the PM MCP token is missing or malformed")]
    InvalidToken,
    #[error("a delivery check starts a fresh conversation with its first message")]
    InvalidDeliveryCheck,
    #[error(transparent)]
    Launch(#[from] InvocationError),
}

/// A resolved launch for the daemon to spawn in a PTY. Its Debug output
/// never shows the environment, where the token is.
pub struct PmLaunchPlan {
    pub mode: PmAgentMode,
    pub agent_id: String,
    pub payload: LaunchPayload,
}

impl std::fmt::Debug for PmLaunchPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PmLaunchPlan")
            .field("mode", &self.mode)
            .field("agent_id", &self.agent_id)
            .field("program", &self.payload.program())
            .field("args", &self.payload.args())
            .finish_non_exhaustive()
    }
}

/// The Claude `--mcp-config` file content: the PM server over HTTP with the
/// bearer read from the environment. It holds no secret; the daemon writes
/// it as a private file and passes its path.
pub fn claude_mcp_config(endpoint: &str) -> Result<String, PmLaunchError> {
    if !loopback_http(endpoint) {
        return Err(PmLaunchError::InvalidEndpoint);
    }
    let config = serde_json::json!({
        "mcpServers": {
            PM_MCP_SERVER_NAME: {
                "type": "http",
                "url": endpoint,
                "headers": { "Authorization": format!("Bearer ${{{MCP_TOKEN_ENV}}}") }
            }
        }
    });
    Ok(config.to_string())
}

fn loopback_http(endpoint: &str) -> bool {
    let Some(rest) = endpoint.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or_default();
    let host = if let Some(bracketed) = authority.strip_prefix('[') {
        match bracketed.split_once(']') {
            Some((host, port)) if port.is_empty() || port.starts_with(':') => host,
            _ => return false,
        }
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
        && !endpoint
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        && !rest.contains('@')
}

fn valid_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= TOKEN_MAX_BYTES
        && token.bytes().all(|byte| byte.is_ascii_graphic())
}

fn template(mode: PmAgentMode) -> &'static PromptTemplate {
    match mode {
        PmAgentMode::Assistant => &ASSISTANT_TEMPLATE,
        PmAgentMode::DeliveryCheck => &DELIVERY_CHECK_TEMPLATE,
    }
}

/// The profile's first message, sent only on a fresh conversation: a
/// resumed assistant conversation already has its opening.
pub(super) fn first_message(profile: &PmAgentProfile, fresh: bool) -> Option<&str> {
    profile.first_message.as_deref().filter(|_| fresh)
}

/// Resolves the PM agent's launch: the profile's system prompt as provider
/// instructions, the PM MCP server, the mode's tools approved, and on a
/// fresh conversation the profile's first message.
pub fn pm_launch_plan(request: PmLaunchRequest<'_>) -> Result<PmLaunchPlan, PmLaunchError> {
    if !matches!(request.agent_id, "claude" | "codex") {
        return Err(PmLaunchError::UnsupportedAgent);
    }
    if !loopback_http(request.mcp_endpoint) {
        return Err(PmLaunchError::InvalidEndpoint);
    }
    if !valid_token(request.mcp_token) {
        return Err(PmLaunchError::InvalidToken);
    }
    let profile = request.profile;
    let fresh = matches!(
        request.conversation,
        AgentConversationLaunch::Fresh { resume_ref: None }
    );
    if profile.mode == PmAgentMode::DeliveryCheck && (!fresh || profile.first_message.is_none()) {
        return Err(PmLaunchError::InvalidDeliveryCheck);
    }
    let template = template(profile.mode);
    let mut launch = LaunchRequest::interactive(request.agent_id, request.cwd, template);
    launch.model = request.model;
    launch.permission = request.permission;
    launch.reasoning = request.reasoning;
    launch.conversation = request.conversation;
    launch.observation = request.observation;
    launch.mcp = Some(McpConnection {
        endpoint: request.mcp_endpoint,
        token: request.mcp_token,
        claude_config_path: request.claude_mcp_config_path,
        server_name: PM_MCP_SERVER_NAME,
        instructions: None,
    });
    launch.provider_instructions_source = Some(template);
    launch.provider_instructions = Some(&profile.system_prompt);
    launch.executable_directory = request.executable_directory;
    launch.approved_tools = profile.tools;
    let mut resolved = resolve(launch)?;
    if let Some(message) = first_message(profile, fresh) {
        let purpose = match profile.mode {
            PmAgentMode::Assistant => "PM assistant kickoff",
            PmAgentMode::DeliveryCheck => "PM delivery check",
        };
        resolved.positional_message(message, template.id, purpose)?;
    }
    Ok(PmLaunchPlan {
        mode: profile.mode,
        agent_id: request.agent_id.to_owned(),
        payload: resolved.into_payload(),
    })
}
