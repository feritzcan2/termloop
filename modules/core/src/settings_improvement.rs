//! Improve-with-agent for one application-settings entry.
//!
//! Every settings improver writes only its target-bound complete version.
//! File-backed entries keep their resolved path in the launch plan for Core's
//! version write; the path is never exposed as direct write authority.

use termloop_invocation::SettingsEntryKind;

/// The maximum bytes the manual editor accepts for a skill definition. It is
/// stated to the improver so an oversized write is refused while the agent can
/// still fix it.
const SKILL_MAX_BYTES: usize = 256 * 1024;
/// The same bound the prompt catalog enforces for a stored prompt override.
const PROMPT_MAX_BYTES: usize = 256 * 1024;
/// The MCP description bound is counted in characters, not bytes, exactly as
/// the manual editor and the named command count it.
const MCP_DESCRIPTION_MAX_CHARACTERS: usize = 4 * 1024;

/// One settings entry an improver launch is aimed at, resolved from where the
/// entry actually lives before the launch is planned.
#[derive(Debug, Clone)]
pub struct SettingsImproverEntry {
    pub kind: SettingsEntryKind,
    /// Skill catalog id, prompt catalog id, or MCP tool name.
    pub id: String,
    /// What the entry is called where the user found it.
    pub name: String,
    /// The exact file Core updates for a version write, empty for an MCP tool description.
    pub path: String,
    /// Which launch profiles receive an MCP tool, empty for the others.
    pub context: String,
    /// The exact current stored text.
    pub content: String,
}

impl SettingsImproverEntry {
    pub fn max_bytes(&self) -> usize {
        match self.kind {
            SettingsEntryKind::Skill => SKILL_MAX_BYTES,
            SettingsEntryKind::Prompt => PROMPT_MAX_BYTES,
            SettingsEntryKind::McpTool => MCP_DESCRIPTION_MAX_CHARACTERS,
        }
    }

    pub fn improver_target(&self) -> termloop_invocation::ImproverTarget<'_> {
        termloop_invocation::ImproverTarget::SettingsEntry {
            kind: self.kind,
            name: &self.name,
            id: &self.id,
            context: &self.context,
            max_bytes: self.max_bytes(),
        }
    }

    /// Durable version identity. Prompt ids are catalog metadata, while the
    /// exact override file is the configuration target the daemon must apply.
    pub fn version_target(&self) -> termloop_domain::ImproverSessionTarget {
        termloop_domain::ImproverSessionTarget {
            target_kind: match self.kind {
                SettingsEntryKind::Skill => {
                    termloop_domain::ImproverSessionTargetKind::SettingsSkill
                }
                SettingsEntryKind::Prompt => {
                    termloop_domain::ImproverSessionTargetKind::SettingsPrompt
                }
                SettingsEntryKind::McpTool => {
                    termloop_domain::ImproverSessionTargetKind::SettingsMcpTool
                }
            },
            target_id: Some(match self.kind {
                SettingsEntryKind::Prompt => self.path.clone(),
                SettingsEntryKind::Skill | SettingsEntryKind::McpTool => self.id.clone(),
            }),
        }
    }

    /// What the Session rail calls this improver, so it never sits there as
    /// another indistinguishable "Claude".
    pub fn session_name(&self) -> String {
        match self.kind {
            SettingsEntryKind::Skill => format!("improve: {} skill", self.name),
            SettingsEntryKind::Prompt => format!("improve: {} prompt", self.name),
            SettingsEntryKind::McpTool => format!("improve: {}", self.name),
        }
    }
}

/// Parses the wire selector a client sends. The kind is closed; the id is
/// bounded by the contract and carried through unchanged.
pub fn settings_entry_kind(wire: &str) -> Option<SettingsEntryKind> {
    match wire {
        "skill" => Some(SettingsEntryKind::Skill),
        "prompt" => Some(SettingsEntryKind::Prompt),
        "mcpTool" => Some(SettingsEntryKind::McpTool),
        _ => None,
    }
}
