import type { ErrorCode, McpToolRole, McpToolSettingsResult, ProtocolErrorDetails } from "@termloop/contract/current";

export const MCP_TOOL_DESCRIPTION_MAX_CHARACTERS = 4_096;
export const MCP_TOOL_ROLES = ["interactive", "improver", "helper", "steward", "worker"] as const satisfies readonly McpToolRole[];

export type McpSettingsMutationResult =
  | { ok: true; result: McpToolSettingsResult }
  | { ok: false; code: ErrorCode | undefined; details: ProtocolErrorDetails | undefined; message: string };

export function mcpToolRoleLabel(role: McpToolRole): "Interactive" | "Improver" | "Helper" | "Steward" | "Worker" {
  switch (role) {
    case "interactive": return "Interactive";
    case "improver": return "Improver";
    case "helper": return "Helper";
    case "steward": return "Steward";
    case "worker": return "Worker";
  }
}

export function mcpToolDescriptionError(description: string): string | undefined {
  if (!description.length || !description.trim().length) return "Description cannot be empty.";
  if (description.trim() !== description) return "Remove leading or trailing whitespace.";
  if ([...description].length > MCP_TOOL_DESCRIPTION_MAX_CHARACTERS) {
    return `Description must be ${MCP_TOOL_DESCRIPTION_MAX_CHARACTERS.toLocaleString("en-US")} characters or fewer.`;
  }
  return undefined;
}
