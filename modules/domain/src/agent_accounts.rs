use serde::{Deserialize, Serialize};

pub const AGENT_ACCOUNTS_PER_PROVIDER_MAX: usize = 16;
pub const SYSTEM_AGENT_ACCOUNT_ID: &str = "default";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentAccountProvider {
    Codex,
    Claude,
}

impl AgentAccountProvider {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            _ => Err("Unsupported provider."),
        }
    }
    pub fn command(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

/// Public local identity only. Provider credentials never enter current state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccount {
    pub agent_id: AgentAccountProvider,
    pub account_id: String,
    pub name: String,
    pub is_default: bool,
}

pub fn valid_agent_account_id(id: &str) -> bool {
    id == SYSTEM_AGENT_ACCOUNT_ID
        || (id.len() == 36
            && id.bytes().enumerate().all(|(i, byte)| {
                if [8, 13, 18, 23].contains(&i) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
                }
            }))
}

impl AgentAccount {
    pub fn is_valid(&self) -> bool {
        valid_agent_account_id(&self.account_id)
            && !self.name.trim().is_empty()
            && self.name.len() <= 80
            && !self.name.chars().any(char::is_control)
            && self.name.trim() == self.name
    }
}

pub fn default_agent_accounts() -> Vec<AgentAccount> {
    [AgentAccountProvider::Codex, AgentAccountProvider::Claude]
        .into_iter()
        .map(|agent_id| AgentAccount {
            agent_id,
            account_id: SYSTEM_AGENT_ACCOUNT_ID.into(),
            name: "Default account".into(),
            is_default: true,
        })
        .collect()
}

pub fn valid_agent_accounts(accounts: &[AgentAccount]) -> bool {
    [AgentAccountProvider::Codex, AgentAccountProvider::Claude]
        .into_iter()
        .all(|provider| {
            let rows: Vec<_> = accounts
                .iter()
                .filter(|account| account.agent_id == provider)
                .collect();
            !rows.is_empty()
                && rows.len() <= AGENT_ACCOUNTS_PER_PROVIDER_MAX
                && rows.iter().filter(|account| account.is_default).count() == 1
                && rows
                    .iter()
                    .any(|account| account.account_id == SYSTEM_AGENT_ACCOUNT_ID)
                && rows.iter().enumerate().all(|(i, account)| {
                    account.is_valid()
                        && !rows[i + 1..].iter().any(|other| {
                            other.account_id == account.account_id
                                || other.name.eq_ignore_ascii_case(&account.name)
                        })
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accounts_are_bounded_unique_and_cannot_be_paths() {
        let mut accounts = default_agent_accounts();
        assert!(valid_agent_accounts(&accounts));
        for id in [
            "../private",
            "",
            "work",
            "00000000-0000-0000-0000-00000000000/",
        ] {
            assert!(!valid_agent_account_id(id));
        }
        accounts.push(accounts[0].clone());
        assert!(!valid_agent_accounts(&accounts));
        accounts.pop();
        accounts[0].is_default = false;
        assert!(!valid_agent_accounts(&accounts));
    }
}
