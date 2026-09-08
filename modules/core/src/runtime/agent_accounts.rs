use crate::{CoreError, CoreRuntime, required_string, store_error};
use serde_json::{Value, json};
use termloop_agents::AgentAccountContext;
use termloop_domain::{AgentAccount, AgentAccountProvider, SYSTEM_AGENT_ACCOUNT_ID};

impl CoreRuntime {
    pub fn agent_account_list(&self) -> Value {
        json!({"accounts": self.store.agent_accounts(), "revision": self.store.revision()})
    }

    /// A missing request selects the configured default only for fresh launches.
    /// Resume callers pass the persisted ID, or the legacy system account ID.
    pub fn resolve_agent_account(
        &self,
        agent_id: &str,
        account_id: Option<&str>,
    ) -> Result<Option<AgentAccountContext>, CoreError> {
        let Ok(provider) = AgentAccountProvider::parse(agent_id) else {
            return if account_id.is_none() {
                Ok(None)
            } else {
                Err(CoreError::InvalidParams(
                    "This provider does not support named accounts".into(),
                ))
            };
        };
        let account = self
            .store
            .agent_accounts()
            .iter()
            .find(|account| {
                account.agent_id == provider
                    && account_id.map_or(account.is_default, |id| account.account_id == id)
            })
            .ok_or_else(|| {
                CoreError::InvalidParams("This account is unavailable on this server".into())
            })?;
        Ok(Some(AgentAccountContext {
            agent_id: agent_id.into(),
            account_id: account.account_id.clone(),
            name: account.name.clone(),
            config_directory: if account.account_id == SYSTEM_AGENT_ACCOUNT_ID {
                None
            } else {
                Some(
                    termloop_platform::canonical_existing_directory_path(
                        self.store.state_directory(),
                    )
                    .map_err(|_| CoreError::Store("Account storage directory unavailable".into()))?
                    .join("agent-accounts")
                    .join(agent_id)
                    .join(&account.account_id),
                )
            },
        }))
    }

    pub(crate) fn session_agent_account(
        &self,
        session: &termloop_domain::SessionRecord,
    ) -> Result<Option<AgentAccountContext>, CoreError> {
        let agent_id = session
            .process
            .agent_id
            .as_deref()
            .ok_or(CoreError::AgentUnsupported)?;
        self.resolve_agent_account(
            agent_id,
            matches!(agent_id, "claude" | "codex").then(|| {
                session
                    .launch_selection
                    .account_id
                    .as_deref()
                    .unwrap_or("default")
            }),
        )
    }

    pub(crate) fn create_agent_account(&mut self, params: Value) -> Result<Value, CoreError> {
        let provider = provider(&params)?;
        let account = AgentAccount {
            agent_id: provider,
            account_id: uuid::Uuid::new_v4().to_string(),
            name: required_string(&params, "name")?.trim().into(),
            is_default: false,
        };
        let id = account.account_id.clone();
        self.store
            .create_agent_account(&self.write_authority, account, revision(&params)?)
            .map_err(store_error)?;
        self.session_history.clear_accounts();
        let mut result = self.agent_account_list();
        result["createdAccountId"] = json!(id);
        Ok(result)
    }

    pub(crate) fn rename_agent_account(&mut self, params: Value) -> Result<Value, CoreError> {
        self.store
            .rename_agent_account(
                &self.write_authority,
                provider(&params)?,
                &required_string(&params, "accountId")?,
                required_string(&params, "name")?.trim(),
                revision(&params)?,
            )
            .map_err(store_error)?;
        Ok(self.agent_account_list())
    }

    pub(crate) fn set_default_agent_account(&mut self, params: Value) -> Result<Value, CoreError> {
        self.store
            .set_default_agent_account(
                &self.write_authority,
                provider(&params)?,
                &required_string(&params, "accountId")?,
                revision(&params)?,
            )
            .map_err(store_error)?;
        Ok(self.agent_account_list())
    }
}

fn provider(params: &Value) -> Result<AgentAccountProvider, CoreError> {
    AgentAccountProvider::parse(&required_string(params, "agentId")?)
        .map_err(|error| CoreError::InvalidParams(error.into()))
}
fn revision(params: &Value) -> Result<u64, CoreError> {
    params["expectedRevision"]
        .as_u64()
        .ok_or_else(|| CoreError::InvalidParams("expectedRevision".into()))
}
