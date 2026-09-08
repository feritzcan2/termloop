use super::super::{CoreWriteAuthority, Store, StoreError};
use termloop_domain::{AgentAccount, AgentAccountProvider, valid_agent_accounts};

impl Store {
    pub fn create_agent_account(
        &mut self,
        _authority: &CoreWriteAuthority,
        account: AgentAccount,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        if self.state.revision != expected_revision {
            return Err(StoreError::RevisionConflict);
        }
        let mut accounts = self.state.agent_accounts.clone();
        accounts.push(account);
        if !valid_agent_accounts(&accounts) {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.agent_accounts = accounts;
        self.commit_or_restore(previous)
    }

    pub fn rename_agent_account(
        &mut self,
        _authority: &CoreWriteAuthority,
        provider: AgentAccountProvider,
        id: &str,
        name: &str,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        if self.state.revision != expected_revision {
            return Err(StoreError::RevisionConflict);
        }
        let mut accounts = self.state.agent_accounts.clone();
        let account = accounts
            .iter_mut()
            .find(|account| account.agent_id == provider && account.account_id == id)
            .ok_or(StoreError::ConstraintViolation)?;
        if account.name == name {
            return Ok(self.state.revision);
        }
        account.name = name.to_owned();
        if !valid_agent_accounts(&accounts) {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.agent_accounts = accounts;
        self.commit_or_restore(previous)
    }

    pub fn set_default_agent_account(
        &mut self,
        _authority: &CoreWriteAuthority,
        provider: AgentAccountProvider,
        id: &str,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        if self.state.revision != expected_revision {
            return Err(StoreError::RevisionConflict);
        }
        let account = self
            .state
            .agent_accounts
            .iter()
            .find(|account| account.agent_id == provider && account.account_id == id)
            .ok_or(StoreError::ConstraintViolation)?;
        if account.is_default {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        for account in &mut self.state.agent_accounts {
            if account.agent_id == provider {
                account.is_default = account.account_id == id;
            }
        }
        self.commit_or_restore(previous)
    }
}
