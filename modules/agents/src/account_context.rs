use std::path::PathBuf;
use termloop_platform::LaunchEnvironment;

/// A validated server-owned account location. Only its local label and opaque
/// identity may enter a public launch preview; never its provider data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentAccountContext {
    pub agent_id: String,
    pub account_id: String,
    pub name: String,
    pub config_directory: Option<PathBuf>,
}

impl AgentAccountContext {
    pub fn apply_environment(&self, environment: LaunchEnvironment) -> LaunchEnvironment {
        match (self.agent_id.as_str(), self.config_directory.as_ref()) {
            ("codex", Some(directory)) => environment.with_explicit("CODEX_HOME", directory),
            ("claude", Some(directory)) => {
                environment.with_explicit("CLAUDE_CONFIG_DIR", directory)
            }
            _ => environment,
        }
    }

    pub fn prepare(&self) -> Result<(), termloop_platform::PlatformError> {
        if let Some(directory) = &self.config_directory {
            // The state root already belongs to Store. Prepare only our three descendants.
            let provider = directory
                .parent()
                .expect("account directory has a provider");
            let accounts = provider
                .parent()
                .expect("provider directory has an accounts root");
            for path in [accounts, provider, directory.as_path()] {
                termloop_platform::ensure_private_directory(path)?;
            }
        }
        Ok(())
    }

    /// Before a launch, shares the server user's own provider setup with this
    /// account's private folder. Best effort: it never fails a launch.
    pub fn share_user_setup(&self) {
        if let ("claude", Some(directory)) = (self.agent_id.as_str(), &self.config_directory)
            && let Some(home) = termloop_platform::user_home_directory()
        {
            crate::claude_profile::share_user_setup(&home, directory);
        }
    }

    pub fn credential_args(&self) -> Vec<String> {
        if self.agent_id == "codex" && self.config_directory.is_some() {
            vec!["-c".into(), "cli_auth_credentials_store=\"file\"".into()]
        } else {
            vec![]
        }
    }
}
