import { describe, expect, it } from "vitest";
import {
  MCP_HELPER_TOOLS,
  MCP_INTERACTIVE_TOOLS,
  MCP_STEWARD_TOOLS,
} from "@termloop/contract/current";
import {
  MCP_TOOL_DESCRIPTION_MAX_CHARACTERS,
  mcpToolDescriptionError,
  mcpToolRoleLabel,
} from "../src/renderer/mcp-settings.js";

describe("MCP settings presentation", () => {
  it("labels generated role values and validates the shared description bound", () => {
    expect(mcpToolRoleLabel("interactive")).toBe("Interactive");
    expect(mcpToolRoleLabel("helper")).toBe("Helper");
    expect(mcpToolRoleLabel("steward")).toBe("Steward");
    expect(mcpToolRoleLabel("improver")).toBe("Improver");
    expect(mcpToolDescriptionError("Visible instruction")).toBeUndefined();
    expect(mcpToolDescriptionError(" instruction ")).toContain("whitespace");
    expect(mcpToolDescriptionError("x".repeat(MCP_TOOL_DESCRIPTION_MAX_CHARACTERS + 1))).toContain("4,096");
  });

  it("labels interactive, Steward, improver, and helper profile scopes", () => {
    expect(MCP_INTERACTIVE_TOOLS).toContain("ask_to");
    expect(MCP_HELPER_TOOLS).toContain("reply_to_request");
    expect(MCP_STEWARD_TOOLS).toContain("project_read");
    expect(MCP_STEWARD_TOOLS).toContain("task_create");
    expect(MCP_STEWARD_TOOLS).toContain("task_delete");
    expect(MCP_STEWARD_TOOLS).toContain("agent_message_send");
    expect(MCP_STEWARD_TOOLS).toContain("steward_complete_assignment");
  });

});
