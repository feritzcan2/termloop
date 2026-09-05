import type { AgentCapabilityDto } from "@termloop/contract/current";

import type {
  AgentLaunchAgentId,
  AgentLaunchPermission,
  AgentLaunchReasoning,
  AgentLaunchSelection,
} from "../application/ports";

export function defaultLaunchSelection(agentId: AgentLaunchAgentId): AgentLaunchSelection {
  return { agentId, model: "default", permission: "default", reasoning: "default" };
}

export function restoreLaunchSelection(
  saved: AgentLaunchSelection | undefined,
  capabilities: readonly AgentCapabilityDto[],
): AgentLaunchSelection {
  const available = capabilities.filter((candidate) => candidate.available);
  const capability = available.find((candidate) => candidate.agent_id === saved?.agentId)
    ?? available[0];
  const agentId = capability?.agent_id ?? saved?.agentId ?? "claude";
  if (capability === undefined || saved === undefined || saved.agentId !== agentId) {
    return defaultLaunchSelection(agentId);
  }
  return {
    agentId,
    model: capability.models.includes(saved.model) ? saved.model : "default",
    permission: capability.permissions.includes(saved.permission) ? saved.permission : "default",
    reasoning: capability.reasoning.includes(saved.reasoning) ? saved.reasoning : "default",
  };
}

/// A model only exists for the provider that offers it, so switching provider
/// cannot silently keep a model the new provider has never heard of.
export function coerceModel(
  agentId: AgentLaunchAgentId,
  model: string,
  capabilities: readonly AgentCapabilityDto[],
): string {
  return capabilities.find((candidate) => candidate.agent_id === agentId)?.models.includes(model)
    ? model
    : "default";
}

export function modelLabel(agentId: AgentLaunchAgentId, model: string): string {
  if (model !== "default") return model;
  return agentId === "claude" ? "Default (recommended)" : "Default";
}

export function permissionLabel(agentId: AgentLaunchAgentId, permission: AgentLaunchPermission): string {
  if (permission === "bypassPermissions") return "bypass";
  if (permission === "acceptEdits") return "accept edits";
  if (permission === "default") return agentId === "claude" ? "auto" : "default";
  return permission;
}

/// Which providers this Mac can actually start. A provider the Mac reports as
/// unavailable is offered as an unselectable fact rather than hidden, so a
/// missing CLI reads as a missing CLI instead of a shorter list.
export function launchAgentOptions(
  capabilities: readonly AgentCapabilityDto[],
): readonly {
  agentId: AgentLaunchAgentId;
  label: string;
  available: boolean;
  version: string | null;
  integrationLevel: AgentCapabilityDto["integration_level"];
  models: readonly string[];
  permissions: readonly AgentLaunchPermission[];
  reasoning: readonly AgentLaunchReasoning[];
}[] {
  return capabilities.map((capability) => ({
    agentId: capability.agent_id,
    label: capability.label,
    available: capability.available,
    version: capability.version,
    integrationLevel: capability.integration_level,
    models: capability.models,
    permissions: capability.permissions,
    reasoning: capability.reasoning,
  }));
}

export function firstAvailableAgent(
  capabilities: readonly AgentCapabilityDto[],
): AgentLaunchAgentId | undefined {
  return launchAgentOptions(capabilities).find((option) => option.available)?.agentId;
}

/// Why a Task cannot host a launch at all. The phone refuses before it reserves
/// a ticket rather than letting core refuse after the user picked four options.
export function launchBlockedReason(task: {
  status: string;
  worktree: { path: string } | null;
  worktree_health?: { launch_ready: boolean } | undefined;
}): string | undefined {
  if (task.status === "closed") return "This Task is closed. Reopen it on your Mac to run agents here.";
  if (task.worktree === null) return "This Task has no worktree. Create one on your Mac first.";
  if (task.worktree_health === undefined) return "Your Mac has not checked this worktree yet.";
  if (!task.worktree_health.launch_ready) return "Your Mac cannot prove this checkout is safe to launch in.";
  return undefined;
}
