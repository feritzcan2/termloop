//! The global Agent settings: the native-fork preference with its visible fork
//! notice, and the restart-continuation preference with its visible prompt.
//!
//! Core owns the durable preferences. Prompt text belongs to invocation; core
//! only returns the authored templates so Settings can show exactly what an
//! Agent receives.

use serde_json::{Value, json};
use termloop_domain::{AgentForkPreference, AgentRestartPreference};

use crate::{CoreError, CoreRuntime, store_error};

impl CoreRuntime {
    pub fn agent_fork_settings_get(&self) -> Value {
        let preference = self.store.agent_fork_preference();
        let restart = self.store.agent_restart_preference();
        json!({
            "systemPromptEnabled": preference.system_prompt_enabled,
            "systemPrompt": termloop_invocation::agent_fork_notice_template().body(),
            "activeSourcePrompt": termloop_invocation::agent_fork_active_source_template().body(),
            "autoContinueInterruptedEnabled": restart.auto_continue_interrupted,
            "restartContinuePrompt": termloop_invocation::agent_restart_continue_template().body(),
        })
    }

    /// Replaces each global Agent preference named in `params`; omitted ones
    /// keep their stored value. The fork preference applies to forks planned
    /// after the write, and the restart preference to resumes that commit
    /// after it. At least one preference must be named.
    pub fn set_agent_fork_settings(&mut self, params: Value) -> Result<Value, CoreError> {
        let optional_bool = |name: &str| match params.get(name) {
            None => Ok(None),
            Some(value) => value
                .as_bool()
                .map(Some)
                .ok_or_else(|| CoreError::InvalidParams(name.into())),
        };
        let system_prompt_enabled = optional_bool("systemPromptEnabled")?;
        let auto_continue_interrupted = optional_bool("autoContinueInterruptedEnabled")?;
        if system_prompt_enabled.is_none() && auto_continue_interrupted.is_none() {
            return Err(CoreError::InvalidParams("systemPromptEnabled".into()));
        }
        if let Some(enabled) = system_prompt_enabled {
            self.store
                .set_agent_fork_preference(
                    &self.write_authority,
                    AgentForkPreference {
                        system_prompt_enabled: enabled,
                    },
                )
                .map_err(store_error)?;
        }
        if let Some(enabled) = auto_continue_interrupted {
            self.store
                .set_agent_restart_preference(
                    &self.write_authority,
                    AgentRestartPreference {
                        auto_continue_interrupted: enabled,
                    },
                )
                .map_err(store_error)?;
        }
        Ok(self.agent_fork_settings_get())
    }
}

#[cfg(test)]
mod tests {
    use crate::{CoreError, CoreRuntime};
    use serde_json::json;

    #[test]
    fn fork_settings_default_on_show_the_notice_and_persist_a_change() {
        let root =
            std::env::temp_dir().join(format!("termloop-fork-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut runtime = CoreRuntime::open(
            root.join("state.json"),
            termloop_terminal::TerminalService::default(),
            1,
        )
        .unwrap();
        let initial = runtime.handle("agent.forkSettingsGet", json!({})).unwrap();
        assert_eq!(initial["systemPromptEnabled"], true);
        assert_eq!(initial["autoContinueInterruptedEnabled"], false);
        assert!(
            initial["systemPrompt"]
                .as_str()
                .unwrap()
                .contains("{{source_session_id}}")
        );
        assert!(
            initial["activeSourcePrompt"]
                .as_str()
                .unwrap()
                .contains("still working")
        );
        assert!(matches!(
            runtime.handle("agent.forkSettingsSet", json!({})),
            Err(CoreError::InvalidParams(_))
        ));
        let updated = runtime
            .handle(
                "agent.forkSettingsSet",
                json!({ "systemPromptEnabled": false }),
            )
            .unwrap();
        assert_eq!(updated["systemPromptEnabled"], false);
        assert_eq!(updated["autoContinueInterruptedEnabled"], false);
        drop(runtime);
        let reopened = CoreRuntime::open(
            root.join("state.json"),
            termloop_terminal::TerminalService::default(),
            2,
        )
        .unwrap();
        assert_eq!(
            reopened.agent_fork_settings_get()["systemPromptEnabled"],
            false
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restart_settings_default_off_update_independently_and_persist() {
        let root = std::env::temp_dir().join(format!(
            "termloop-restart-settings-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut runtime = CoreRuntime::open(
            root.join("state.json"),
            termloop_terminal::TerminalService::default(),
            1,
        )
        .unwrap();
        let initial = runtime.handle("agent.forkSettingsGet", json!({})).unwrap();
        assert_eq!(initial["autoContinueInterruptedEnabled"], false);
        assert_eq!(initial["restartContinuePrompt"], "Continue your work.\n");
        assert!(matches!(
            runtime.handle(
                "agent.forkSettingsSet",
                json!({ "autoContinueInterruptedEnabled": "yes" })
            ),
            Err(CoreError::InvalidParams(_))
        ));
        let updated = runtime
            .handle(
                "agent.forkSettingsSet",
                json!({ "autoContinueInterruptedEnabled": true }),
            )
            .unwrap();
        assert_eq!(updated["autoContinueInterruptedEnabled"], true);
        assert_eq!(updated["systemPromptEnabled"], true);
        drop(runtime);
        let reopened = CoreRuntime::open(
            root.join("state.json"),
            termloop_terminal::TerminalService::default(),
            2,
        )
        .unwrap();
        let settings = reopened.agent_fork_settings_get();
        assert_eq!(settings["autoContinueInterruptedEnabled"], true);
        assert_eq!(settings["systemPromptEnabled"], true);
        let _ = std::fs::remove_dir_all(root);
    }
}
