use termloop_domain::{McpToolDescription, McpToolDescriptionOverride, McpToolName};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn update_mcp_tool_description(
        &mut self,
        _authority: &CoreWriteAuthority,
        tool: McpToolName,
        description: McpToolDescription,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        if self.state.revision != expected_revision {
            return Err(StoreError::RevisionConflict);
        }
        if self
            .state
            .mcp_tool_description_overrides
            .iter()
            .find(|value| value.tool == tool)
            .is_some_and(|value| value.description == description)
        {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        if let Some(value) = self
            .state
            .mcp_tool_description_overrides
            .iter_mut()
            .find(|value| value.tool == tool)
        {
            value.description = description;
        } else {
            self.state
                .mcp_tool_description_overrides
                .push(McpToolDescriptionOverride { tool, description });
        }
        self.state
            .mcp_tool_description_overrides
            .sort_by_key(|value| value.tool.as_str());
        self.commit_or_restore(previous)
    }

    pub fn reset_mcp_tool_description(
        &mut self,
        _authority: &CoreWriteAuthority,
        tool: McpToolName,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        if self.state.revision != expected_revision {
            return Err(StoreError::RevisionConflict);
        }
        let Some(index) = self
            .state
            .mcp_tool_description_overrides
            .iter()
            .position(|value| value.tool == tool)
        else {
            return Ok(self.state.revision);
        };
        let previous = self.state.clone();
        self.state.mcp_tool_description_overrides.remove(index);
        self.commit_or_restore(previous)
    }
}
