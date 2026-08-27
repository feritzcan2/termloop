use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::{Arc, RwLock};

use serde_json::{Value, json};
use termloop_domain::{McpToolDescription, McpToolName};

use crate::{CoreError, CoreRuntime, store_error};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum McpToolRole {
    Interactive,
    Improver,
    Helper,
    Steward,
    Worker,
}

impl McpToolRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::Improver => "improver",
            Self::Helper => "helper",
            Self::Steward => "steward",
            Self::Worker => "worker",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolCatalogEntry {
    pub name: McpToolName,
    pub title: String,
    pub canonical_description: String,
    pub roles: Vec<McpToolRole>,
}

#[derive(Clone, Default)]
pub struct McpToolDescriptions {
    effective: Arc<RwLock<HashMap<McpToolName, String>>>,
}

impl McpToolDescriptions {
    pub fn description(&self, name: &str) -> Option<String> {
        let name = McpToolName::from_str(name).ok()?;
        self.effective.read().ok()?.get(&name).cloned()
    }

    fn replace(&self, descriptions: HashMap<McpToolName, String>) -> Result<(), CoreError> {
        *self
            .effective
            .write()
            .map_err(|_| CoreError::Store("MCP description snapshot is unavailable".into()))? =
            descriptions;
        Ok(())
    }
}

impl CoreRuntime {
    pub fn configure_mcp_tool_catalog(
        &mut self,
        catalog: Vec<McpToolCatalogEntry>,
    ) -> Result<(), CoreError> {
        validate_catalog(&catalog)?;
        self.mcp_tool_catalog = catalog;
        self.refresh_mcp_tool_descriptions()
    }

    pub fn mcp_tool_descriptions(&self) -> McpToolDescriptions {
        self.mcp_tool_descriptions.clone()
    }

    pub(crate) fn mcp_tool_settings_get(&self) -> Result<Value, CoreError> {
        self.mcp_tool_settings_result()
    }

    pub(crate) fn update_mcp_tool_description(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let tool = tool_param(&params)?;
        let description = params
            .get("description")
            .and_then(Value::as_str)
            .and_then(|value| McpToolDescription::new(value.to_owned()))
            .ok_or_else(|| CoreError::InvalidParams("description".into()))?;
        let expected_revision = revision_param(&params)?;
        self.store
            .update_mcp_tool_description(
                &self.write_authority,
                tool,
                description,
                expected_revision,
            )
            .map_err(store_error)?;
        self.refresh_mcp_tool_descriptions()?;
        self.mcp_tool_settings_result()
    }

    pub(crate) fn reset_mcp_tool_description(&mut self, params: Value) -> Result<Value, CoreError> {
        let tool = tool_param(&params)?;
        let expected_revision = revision_param(&params)?;
        self.store
            .reset_mcp_tool_description(&self.write_authority, tool, expected_revision)
            .map_err(store_error)?;
        self.refresh_mcp_tool_descriptions()?;
        self.mcp_tool_settings_result()
    }

    fn refresh_mcp_tool_descriptions(&self) -> Result<(), CoreError> {
        let descriptions = self
            .mcp_tool_catalog
            .iter()
            .map(|tool| {
                let description = self
                    .store
                    .mcp_tool_description_overrides()
                    .iter()
                    .find(|value| value.tool == tool.name)
                    .map(|value| value.description.as_str())
                    .unwrap_or(&tool.canonical_description)
                    .to_owned();
                (tool.name, description)
            })
            .collect();
        self.mcp_tool_descriptions.replace(descriptions)
    }

    fn mcp_tool_settings_result(&self) -> Result<Value, CoreError> {
        if self.mcp_tool_catalog.len() != McpToolName::ALL.len() {
            return Err(CoreError::Store(
                "MCP tool catalog is not configured".into(),
            ));
        }
        let overrides = self.store.mcp_tool_description_overrides();
        let tools = self
            .mcp_tool_catalog
            .iter()
            .map(|tool| {
                let override_description = overrides
                    .iter()
                    .find(|value| value.tool == tool.name)
                    .map(|value| value.description.as_str());
                json!({
                    "name": tool.name.as_str(),
                    "title": tool.title,
                    "canonicalDescription": tool.canonical_description,
                    "effectiveDescription": override_description.unwrap_or(&tool.canonical_description),
                    "customized": override_description.is_some(),
                    "roles": tool.roles.iter().map(|role| role.as_str()).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "stateRevision": self.store.revision(), "tools": tools }))
    }
}

fn tool_param(params: &Value) -> Result<McpToolName, CoreError> {
    params
        .get("tool")
        .and_then(Value::as_str)
        .and_then(|value| McpToolName::from_str(value).ok())
        .ok_or_else(|| CoreError::InvalidParams("tool".into()))
}

fn revision_param(params: &Value) -> Result<u64, CoreError> {
    params
        .get("expectedRevision")
        .and_then(Value::as_u64)
        .ok_or_else(|| CoreError::InvalidParams("expectedRevision".into()))
}

fn validate_catalog(catalog: &[McpToolCatalogEntry]) -> Result<(), CoreError> {
    let names = catalog.iter().map(|tool| tool.name).collect::<HashSet<_>>();
    let roles_are_valid = catalog.iter().all(|tool| {
        let roles = tool.roles.iter().copied().collect::<HashSet<_>>();
        !tool.title.is_empty()
            && tool.title.chars().count() <= 256
            && McpToolDescription::new(tool.canonical_description.clone()).is_some()
            && !roles.is_empty()
            && roles.len() == tool.roles.len()
    });
    (catalog.len() == McpToolName::ALL.len()
        && names.len() == McpToolName::ALL.len()
        && McpToolName::ALL.iter().all(|name| names.contains(name))
        && roles_are_valid)
        .then_some(())
        .ok_or_else(|| CoreError::InvalidParams("mcpToolCatalog".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_store::Store;
    use termloop_terminal::TerminalService;
    use uuid::Uuid;

    fn runtime() -> (CoreRuntime, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-mcp-settings-{}-{}.json",
            std::process::id(),
            Uuid::new_v4()
        ));
        let mut runtime = CoreRuntime::new(
            Store::open(&path).unwrap(),
            termloop_store::issue_core_write_authority_for_composition(),
            TerminalService::with_process_registry(path.with_extension("processes")),
            1,
        )
        .unwrap();
        runtime
            .configure_mcp_tool_catalog(
                McpToolName::ALL
                    .into_iter()
                    .map(|name| McpToolCatalogEntry {
                        name,
                        title: format!("{} title", name.as_str()),
                        canonical_description: match name {
                            McpToolName::AskTo => "Canonical Ask-To description".into(),
                            McpToolName::SendToAgent => {
                                "Canonical Send-To-Agent description".into()
                            }
                            McpToolName::ReplyToRequest => "Canonical reply description".into(),
                            _ => format!("Canonical {} description", name.as_str()),
                        },
                        roles: match name {
                            McpToolName::AskTo | McpToolName::SendToAgent => {
                                vec![McpToolRole::Interactive, McpToolRole::Improver]
                            }
                            McpToolName::PlaybookRead => {
                                vec![McpToolRole::Steward]
                            }
                            McpToolName::ConfigurationVersionRead
                            | McpToolName::ConfigurationVersionWrite => vec![McpToolRole::Improver],
                            McpToolName::ReplyToRequest => vec![McpToolRole::Helper],
                            McpToolName::WorkerGetNextRoutine
                            | McpToolName::WorkerCompleteRoutine
                            | McpToolName::WorkerReportRoutineProblem => vec![McpToolRole::Worker],
                            _ => vec![McpToolRole::Steward],
                        },
                    })
                    .collect(),
            )
            .unwrap();
        (runtime, path)
    }

    #[test]
    fn update_and_reset_refresh_the_effective_snapshot_with_revision_cas() {
        let (mut runtime, path) = runtime();
        let revision = runtime.state_revision();
        let result = runtime
            .handle(
                "mcp.toolDescriptionUpdate",
                json!({
                    "tool": "ask_to",
                    "description": "Always use the visible helper.",
                    "expectedRevision": revision,
                }),
            )
            .unwrap();
        assert_eq!(result["tools"][0]["customized"], true);
        assert_eq!(
            runtime
                .mcp_tool_descriptions()
                .description("ask_to")
                .as_deref(),
            Some("Always use the visible helper.")
        );
        assert!(matches!(
            runtime.handle(
                "mcp.toolDescriptionReset",
                json!({ "tool": "ask_to", "expectedRevision": revision })
            ),
            Err(CoreError::RevisionConflict)
        ));
        let current = runtime.state_revision();
        runtime
            .handle(
                "mcp.toolDescriptionReset",
                json!({ "tool": "ask_to", "expectedRevision": current }),
            )
            .unwrap();
        assert_eq!(
            runtime
                .mcp_tool_descriptions()
                .description("ask_to")
                .as_deref(),
            Some("Canonical Ask-To description")
        );
        let _ = std::fs::remove_file(path);
    }
}
