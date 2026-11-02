//! The global native-fork preference and its visible fork notice.
//!
//! Core owns the durable preference. The notice text belongs to invocation;
//! core only returns the authored template so Settings can show exactly what a
//! fork receives.

use serde_json::{Value, json};
use termloop_domain::AgentForkPreference;

use crate::{CoreError, CoreRuntime, store_error};

impl CoreRuntime {
    pub fn agent_fork_settings_get(&self) -> Value {
        let preference = self.store.agent_fork_preference();
        json!({
            "systemPromptEnabled": preference.system_prompt_enabled,
            "systemPrompt": termloop_invocation::agent_fork_notice_template().authored_body,
        })
    }

    /// Replaces the single global fork preference. It applies to forks planned
    /// after the write; running forks keep the instructions they launched with.
    pub fn set_agent_fork_settings(&mut self, params: Value) -> Result<Value, CoreError> {
        let enabled = params
            .get("systemPromptEnabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| CoreError::InvalidParams("systemPromptEnabled".into()))?;
        self.store
            .set_agent_fork_preference(
                &self.write_authority,
                AgentForkPreference {
                    system_prompt_enabled: enabled,
                },
            )
            .map_err(store_error)?;
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
        assert!(
            initial["systemPrompt"]
                .as_str()
                .unwrap()
                .contains("{{source_session_id}}")
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
}
