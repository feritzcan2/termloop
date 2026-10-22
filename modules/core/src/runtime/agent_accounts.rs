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

    /// Commits the record removal and returns the removed account's context so
    /// the caller can sign it out and dispose of its private directory outside
    /// the core lock. Sessions pinned to the account keep it alive.
    pub fn delete_agent_account(
        &mut self,
        params: Value,
    ) -> Result<(Value, AgentAccountContext), CoreError> {
        let provider = provider(&params)?;
        let id = required_string(&params, "accountId")?;
        if id == SYSTEM_AGENT_ACCOUNT_ID {
            return Err(CoreError::InvalidParams(
                "The server account cannot be removed".into(),
            ));
        }
        let account = self
            .resolve_agent_account(provider.command(), Some(&id))?
            .ok_or(CoreError::NotFound)?;
        let pinned = self
            .store
            .sessions()
            .iter()
            .filter(|session| {
                session.process.agent_id.as_deref() == Some(provider.command())
                    && session.launch_selection.account_id.as_deref() == Some(id.as_str())
            })
            .count();
        if pinned > 0 {
            return Err(CoreError::InvalidParams(format!(
                "{pinned} {} still {} this account. Switch {} to another account or close {} first",
                if pinned == 1 { "Session" } else { "Sessions" },
                if pinned == 1 { "uses" } else { "use" },
                if pinned == 1 { "it" } else { "them" },
                if pinned == 1 { "it" } else { "them" },
            )));
        }
        self.store
            .delete_agent_account(&self.write_authority, provider, &id, revision(&params)?)
            .map_err(store_error)?;
        self.session_history.clear_accounts();
        Ok((self.agent_account_list(), account))
    }

    /// Plans moving one Agent Session's conversation to another account of the
    /// same provider. The caller shares the transcript outside the core lock,
    /// then applies the plan, which revalidates the Session first.
    pub fn plan_agent_account_switch(
        &self,
        params: &Value,
    ) -> Result<AgentAccountSwitchPlan, CoreError> {
        let session_id = required_string(params, "sessionId")?;
        let account_id = required_string(params, "accountId")?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        if session.kind != termloop_domain::SessionKind::Agent {
            return Err(CoreError::AgentUnsupported);
        }
        let from = self
            .session_agent_account(session)?
            .ok_or(CoreError::AgentUnsupported)?;
        let to = self
            .resolve_agent_account(&from.agent_id, Some(&account_id))?
            .ok_or(CoreError::AgentUnsupported)?;
        Ok(AgentAccountSwitchPlan {
            session_id,
            runtime_epoch: session.runtime_epoch,
            running: session.lifecycle_state == "running",
            resume: session.resume_ref.clone(),
            unchanged: from.account_id == to.account_id,
            from,
            to,
        })
    }

    pub fn apply_agent_account_switch(
        &mut self,
        plan: &AgentAccountSwitchPlan,
    ) -> Result<Value, CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == plan.session_id)
            .ok_or(CoreError::NotFound)?;
        if session.resume_ref != plan.resume {
            return Err(CoreError::RevisionConflict);
        }
        self.store
            .switch_agent_session_account(
                &self.write_authority,
                &plan.session_id,
                plan.runtime_epoch,
                &plan.to.account_id,
            )
            .map_err(|error| match error {
                termloop_store::StoreError::ConstraintViolation => CoreError::RevisionConflict,
                error => store_error(error),
            })?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == plan.session_id)
            .ok_or(CoreError::NotFound)?;
        Ok(self.project_session(session))
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

/// A planned Session account move; see `plan_agent_account_switch`.
pub struct AgentAccountSwitchPlan {
    pub session_id: String,
    pub runtime_epoch: u64,
    pub running: bool,
    pub unchanged: bool,
    pub resume: Option<termloop_domain::ResumeRef>,
    pub from: AgentAccountContext,
    pub to: AgentAccountContext,
}

impl AgentAccountSwitchPlan {
    /// Blocking: shares the Session's transcript with the target account. Run
    /// it outside the core lock. A Session without a conversation needs none.
    pub fn share_transcript(&self) -> Result<(), CoreError> {
        let Some(resume) = &self.resume else {
            return Ok(());
        };
        match termloop_agents::bridge_agent_conversation(&self.from, &self.to, resume) {
            Ok(true) => Ok(()),
            Ok(false) => Err(CoreError::InvalidParams(
                "This conversation's transcript was not found, so it cannot continue on another account"
                    .into(),
            )),
            Err(error) => Err(CoreError::Terminal(error.into())),
        }
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
