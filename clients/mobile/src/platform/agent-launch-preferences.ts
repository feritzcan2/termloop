import * as SecureStore from "expo-secure-store";

import type {
  AgentLaunchPermission,
  AgentLaunchReasoning,
  AgentLaunchSelection,
} from "@/application/ports";

const STORAGE_KEY = "termloop.agent-launch-selection.v1";
const PERMISSIONS = new Set<AgentLaunchPermission>(["default", "acceptEdits", "plan", "bypassPermissions"]);
const REASONING = new Set<AgentLaunchReasoning>(["default", "low", "medium", "high", "xhigh", "max"]);

export const agentLaunchPreferences = {
  async read(): Promise<AgentLaunchSelection | undefined> {
    const stored = await SecureStore.getItemAsync(STORAGE_KEY);
    if (stored === null) return undefined;
    try {
      return parseSelection(JSON.parse(stored));
    } catch {
      return undefined;
    }
  },

  async write(selection: AgentLaunchSelection): Promise<void> {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(selection));
  },
};

function parseSelection(value: unknown): AgentLaunchSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.agentId !== "string" || candidate.agentId.length === 0) return undefined;
  if (typeof candidate.model !== "string" || candidate.model.length === 0) return undefined;
  if (!PERMISSIONS.has(candidate.permission as AgentLaunchPermission)) return undefined;
  if (!REASONING.has(candidate.reasoning as AgentLaunchReasoning)) return undefined;
  return {
    agentId: candidate.agentId,
    model: candidate.model,
    permission: candidate.permission as AgentLaunchPermission,
    reasoning: candidate.reasoning as AgentLaunchReasoning,
  };
}
