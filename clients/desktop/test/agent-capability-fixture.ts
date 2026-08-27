import type { AgentCapabilityDto } from "@termloop/contract/current";

const MODELS: Record<string, string[]> = {
  claude: ["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"],
  codex: ["default", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.5-pro"],
  gemini: ["default", "auto", "pro", "flash", "flash-lite"],
};

export function fullAgentCapability(
  agentId: "claude" | "codex",
  overrides: Partial<AgentCapabilityDto> = {},
): AgentCapabilityDto {
  return {
    agent_id: agentId,
    label: agentId === "claude" ? "Claude" : "Codex",
    available: true,
    version: "1",
    integration_level: "full",
    degraded_reason: null,
    models: MODELS[agentId]!,
    permissions: ["default", "acceptEdits", "plan", "bypassPermissions"],
    reasoning: ["default", "low", "medium", "high", "xhigh", "max"],
    observation_supported: true,
    quick_action_supported: true,
    tracked_helpers_supported: true,
    resume_supported: true,
    native_fork_supported: true,
    ...overrides,
  };
}

export function launchOnlyGeminiCapability(
  overrides: Partial<AgentCapabilityDto> = {},
): AgentCapabilityDto {
  return {
    agent_id: "gemini",
    label: "Gemini CLI",
    available: true,
    version: "0.39.1",
    integration_level: "launchOnly",
    degraded_reason: "observationUnavailable",
    models: MODELS.gemini!,
    permissions: ["default", "acceptEdits", "plan", "bypassPermissions"],
    reasoning: ["default"],
    observation_supported: false,
    quick_action_supported: false,
    tracked_helpers_supported: false,
    resume_supported: false,
    native_fork_supported: false,
    ...overrides,
  };
}

export function observableGeminiCapability(
  overrides: Partial<AgentCapabilityDto> = {},
): AgentCapabilityDto {
  return launchOnlyGeminiCapability({
    integration_level: "observable",
    degraded_reason: "resumeUnavailable",
    observation_supported: true,
    quick_action_supported: true,
    ...overrides,
  });
}
