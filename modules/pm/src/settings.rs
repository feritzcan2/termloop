//! The PM app's agent settings: which provider, account, model, and
//! permission modes the assistant and delivery checks launch with. The store
//! checks the shape; the daemon checks the values against the agent catalog.

pub const PM_AGENT_PROVIDERS: &[&str] = &["claude", "codex"];
const SETTING_VALUE_MAX_BYTES: usize = 64;
const ACCOUNT_ID_MAX_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PmSettings {
    /// `claude` or `codex`.
    pub agent_provider: String,
    #[serde(default)]
    pub agent_account_id: Option<String>,
    pub agent_model: String,
    pub assistant_permission: String,
    /// A delivery check runs unattended, so it needs a permission mode that
    /// never waits for a human.
    pub check_permission: String,
}

impl Default for PmSettings {
    fn default() -> Self {
        Self {
            agent_provider: "claude".to_owned(),
            agent_account_id: None,
            agent_model: "default".to_owned(),
            assistant_permission: "default".to_owned(),
            check_permission: "bypassPermissions".to_owned(),
        }
    }
}

/// A partial settings change; `agent_account_id: Some(None)` clears it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SettingsEdit {
    pub agent_provider: Option<String>,
    pub agent_account_id: Option<Option<String>>,
    pub agent_model: Option<String>,
    pub assistant_permission: Option<String>,
    pub check_permission: Option<String>,
}

/// A catalog value such as a model or permission mode: `^[A-Za-z0-9._-]+$`.
pub fn valid_setting_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= SETTING_VALUE_MAX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

impl PmSettings {
    /// The first invalid field, by its wire name.
    pub fn invalid_field(&self) -> Option<&'static str> {
        if !PM_AGENT_PROVIDERS.contains(&self.agent_provider.as_str()) {
            return Some("agentProvider");
        }
        if self.agent_account_id.as_deref().is_some_and(|account| {
            account.is_empty()
                || account.len() > ACCOUNT_ID_MAX_BYTES
                || !account.bytes().all(|byte| byte.is_ascii_graphic())
        }) {
            return Some("agentAccountId");
        }
        [
            ("agentModel", &self.agent_model),
            ("assistantPermission", &self.assistant_permission),
            ("checkPermission", &self.check_permission),
        ]
        .into_iter()
        .find(|(_, value)| !valid_setting_value(value))
        .map(|(name, _)| name)
    }

    /// These settings with `edit` applied; nothing is validated here.
    pub fn edited(&self, edit: SettingsEdit) -> Self {
        Self {
            agent_provider: edit
                .agent_provider
                .unwrap_or_else(|| self.agent_provider.clone()),
            agent_account_id: edit
                .agent_account_id
                .unwrap_or_else(|| self.agent_account_id.clone()),
            agent_model: edit.agent_model.unwrap_or_else(|| self.agent_model.clone()),
            assistant_permission: edit
                .assistant_permission
                .unwrap_or_else(|| self.assistant_permission.clone()),
            check_permission: edit
                .check_permission
                .unwrap_or_else(|| self.check_permission.clone()),
        }
    }
}
