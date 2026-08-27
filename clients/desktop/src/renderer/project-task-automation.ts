import type {
  AgentCapabilityDto,
  ProjectTaskAutomationConfigurationDto,
  TaskCreateWorktreeIntent,
} from "@termloop/contract/current";

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/// Project-level "what happens when a Task is created" defaults. The same two
/// facts apply to a manual Create Task, a Project Assistant-created Task, a
/// provider import, and any future Task creation path.
export type ProjectTaskAutomationDraft = {
  createWorktree: boolean;
  worktreePrefix: string;
  agentId: string | null;
  model: string | null;
  permission: AgentCapabilityDto["permissions"][number] | null;
  reasoning: AgentCapabilityDto["reasoning"][number] | null;
  kickoffMessage: string | null;
};

export const PROJECT_TASK_AUTOMATION_KICKOFF_MAX_BYTES = 8_192;
export const DEFAULT_TASK_WORKTREE_PREFIX = "termloop";
export const DEFAULT_TASK_KICKOFF_MESSAGE =
  "Work on this Task end to end. Implement the required changes, run focused tests, and continue until it is complete.";

export const PROJECT_TASK_AUTOMATION_SCOPE_COPY =
  "Applies to every new Task in this Project — created by hand, by the Project Assistant, or imported from any source.";

export function projectTaskAutomationDraftFrom(
  configuration: ProjectTaskAutomationConfigurationDto,
): ProjectTaskAutomationDraft {
  return {
    createWorktree: configuration.createWorktree,
    worktreePrefix: configuration.worktreePrefix,
    agentId: configuration.agentId,
    model: configuration.model,
    permission: configuration.permission,
    reasoning: configuration.reasoning,
    kickoffMessage: configuration.kickoffMessage,
  };
}

/// Mirrors the generated constraint: an agent can only start inside a worktree,
/// so a named agent without one is refused next to the control instead of by a
/// rejected round trip.
export function projectTaskAutomationError(draft: ProjectTaskAutomationDraft): string | undefined {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(draft.worktreePrefix)) {
    return "Use 1–32 lowercase letters, numbers, or single hyphens for the branch/worktree prefix.";
  }
  if (draft.agentId === null) {
    return draft.model === null && draft.permission === null && draft.reasoning === null && draft.kickoffMessage === null
      ? undefined
      : "Model, permission, reasoning, and kickoff message require an agent.";
  }
  if (!draft.createWorktree) return "Starting an agent requires worktree creation.";
  if (draft.agentId.trim().length === 0 || utf8ByteLength(draft.agentId) > 64) return "Choose a configured agent.";
  if (!draft.model?.trim() || utf8ByteLength(draft.model) > 80) return "Choose a model for the agent.";
  if (!draft.permission) return "Choose a permission mode for the agent.";
  if (!draft.reasoning) return "Choose a reasoning level for the agent.";
  if (draft.kickoffMessage !== null) {
    if (!draft.kickoffMessage.trim()) return "Enter a kickoff message or turn it off.";
    if (utf8ByteLength(draft.kickoffMessage) > PROJECT_TASK_AUTOMATION_KICKOFF_MAX_BYTES) {
      return "Keep the kickoff message within 8192 bytes.";
    }
  }
  return undefined;
}

export function projectTaskAutomationChanged(
  draft: ProjectTaskAutomationDraft,
  configuration: ProjectTaskAutomationConfigurationDto,
): boolean {
  return draft.createWorktree !== configuration.createWorktree
    || draft.worktreePrefix !== configuration.worktreePrefix
    || draft.agentId !== configuration.agentId
    || draft.model !== configuration.model
    || draft.permission !== configuration.permission
    || draft.reasoning !== configuration.reasoning
    || draft.kickoffMessage !== configuration.kickoffMessage;
}

/// One line naming what a new Task gets by default, for Project settings,
/// source summaries, and one-shot import confirmation.
export function taskAutomationSummary(draft: ProjectTaskAutomationDraft, agentName?: string): string {
  if (!draft.createWorktree) return "Task only — no worktree, no agent";
  if (draft.agentId === null) return "Task and worktree — no agent";
  const selection = [draft.model, draft.permission ? permissionLabel(draft.permission) : null, draft.reasoning ? `${draft.reasoning} reasoning` : null]
    .filter((value): value is string => value !== null)
    .join(" · ");
  return `Task, worktree, and ${agentName ?? draft.agentId}${selection ? ` · ${selection}` : ""}${draft.kickoffMessage === null ? "" : " · kickoff message"}`;
}

/// What the user checked in an import confirmation. It deliberately matches the
/// Project default shape so prefilling is a copy rather than a mapping.
export type TaskImportChoice = ProjectTaskAutomationDraft;

/// The one-shot selection sent with an explicit import. `inherit` is never sent
/// from here: the confirmation showed the resolved choice, so the daemon must
/// act on exactly that choice if the Project default changes meanwhile.
export function taskCreationIntent(choice: TaskImportChoice): {
  worktreeIntent: TaskCreateWorktreeIntent;
  worktreePrefix: string | null;
  agentId: string | null;
  model: string | null;
  permission: AgentCapabilityDto["permissions"][number] | null;
  reasoning: AgentCapabilityDto["reasoning"][number] | null;
  kickoffMessage: string | null;
} {
  if (!choice.createWorktree || choice.agentId === null) {
    return choice.createWorktree
      ? { worktreeIntent: "provision", worktreePrefix: choice.worktreePrefix, agentId: null, model: null, permission: null, reasoning: null, kickoffMessage: null }
      : { worktreeIntent: "none", worktreePrefix: null, agentId: null, model: null, permission: null, reasoning: null, kickoffMessage: null };
  }
  if (choice.model === null || choice.permission === null || choice.reasoning === null) {
    throw new Error("An explicit Task Agent selection requires model, permission, and reasoning.");
  }
  return {
    worktreeIntent: "provision",
    worktreePrefix: choice.worktreePrefix,
    agentId: choice.agentId,
    model: choice.model,
    permission: choice.permission,
    reasoning: choice.reasoning,
    kickoffMessage: choice.kickoffMessage,
  };
}

export type AgentChoiceOption = { agentId: string; label: string; available: boolean };

/// Every available agent plus a selected unavailable agent. A Project default
/// naming a retired agent must remain visible instead of silently changing.
export function agentChoiceOptions(
  capabilities: readonly AgentCapabilityDto[],
  selected: string | null,
): AgentChoiceOption[] {
  const available = capabilities
    .filter((capability) => capability.available)
    .map((capability) => ({ agentId: capability.agent_id, label: capability.label, available: true }));
  if (selected === null || available.some((option) => option.agentId === selected)) return available;
  const known = capabilities.find((capability) => capability.agent_id === selected);
  return [{ agentId: selected, label: known?.label ?? selected, available: false }, ...available];
}

export function defaultAgentId(capabilities: readonly AgentCapabilityDto[]): string | null {
  return capabilities.find((capability) => capability.available)?.agent_id ?? null;
}

export function agentLaunchDefaults(
  capabilities: readonly AgentCapabilityDto[],
  agentId: string,
): Pick<ProjectTaskAutomationDraft, "model" | "permission" | "reasoning"> {
  const capability = capabilities.find((candidate) => candidate.agent_id === agentId);
  return {
    model: capability?.models[0] ?? "default",
    permission: capability?.permissions[0] ?? "default",
    reasoning: capability?.reasoning[0] ?? "default",
  };
}

export function permissionLabel(permission: NonNullable<ProjectTaskAutomationDraft["permission"]>): string {
  switch (permission) {
    case "acceptEdits": return "accept edits";
    case "bypassPermissions": return "bypass permissions";
    default: return permission;
  }
}

export function agentLabel(capabilities: readonly AgentCapabilityDto[], agentId: string | null): string | undefined {
  if (agentId === null) return undefined;
  return capabilities.find((capability) => capability.agent_id === agentId)?.label ?? agentId;
}
