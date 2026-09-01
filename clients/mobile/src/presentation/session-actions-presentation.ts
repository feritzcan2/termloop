import type {
  AgentCapabilityDto,
  SessionDto,
  SessionRelocationBlocker,
  SessionRelocationWarning,
  TaskDto,
} from "@termloop/contract/current";

import { isAssistantSession } from "./dto-readers";

export type SessionDismissAction = {
  command: "terminate" | "close";
  label: "Close Session" | "Remove Session";
  detail: string;
};

export type SessionCoordinationActions = {
  askTargets: readonly { agentId: "claude" | "codex"; label: string }[];
  handoverTargets: readonly SessionDto[];
};

export type SessionActionPresentation = {
  attachedTask: TaskDto | undefined;
  coordination: SessionCoordinationActions | undefined;
  canRefresh: boolean;
  canFork: boolean;
  canRepairProviderHistory: boolean;
  taskRelocationTargets: readonly TaskDto[];
  canRelocateToProject: boolean;
  canCopyId: boolean;
  dismissal: SessionDismissAction | undefined;
};

/// Mirrors the desktop Session menu's projection gates. The phone derives only
/// which named command to offer; Core still makes every lifecycle decision.
export function sessionActionPresentation(
  session: SessionDto,
  sessions: readonly SessionDto[],
  tasks: readonly TaskDto[],
  capabilities: readonly AgentCapabilityDto[],
): SessionActionPresentation {
  const attachedTask = tasks.find((task) => (
    task.worktree_presence?.attached_sessions.some((entry) => entry.session_id === session.id)
  ));
  const coordination = coordinationActions(session, sessions, capabilities);
  const relocatable = session.kind === "Agent"
    && (session.lifecycle_state === "running"
      || (session.lifecycle_state === "resumeFailed" && session.retryable))
    && (session.process.agent_id === "claude" || session.process.agent_id === "codex");
  const ordinaryRelocatable = relocatable
    && session.ask_to_source_session_id === null
    && (session.process.template_ref === "builtin.agent.interactive"
      || session.process.template_ref === "builtin.quick-action.free-prompt");

  return {
    attachedTask,
    coordination,
    canRefresh: coordination !== undefined,
    canFork: session.kind === "Agent",
    canRepairProviderHistory: session.kind === "Agent"
      && session.resume_failure_reason === "providerHistoryDamaged",
    taskRelocationTargets: ordinaryRelocatable && attachedTask === undefined
      ? tasks.filter((task) => task.status === "open" && task.archived_at_epoch_ms === null)
      : [],
    canRelocateToProject: relocatable && attachedTask !== undefined && !isAssistantSession(session),
    canCopyId: session.kind === "Agent",
    dismissal: sessionDismissAction(session),
  };
}

export function sessionDismissAction(session: SessionDto): SessionDismissAction | undefined {
  if (session.lifecycle_state === "running" || session.lifecycle_state === "resuming"
    || (session.lifecycle_state === "resumeFailed" && session.retryable && !session.closable)) {
    return {
      command: "terminate",
      label: "Close Session",
      detail: session.kind === "Agent"
        ? "End this Agent and keep it in Deleted for 30 days"
        : "End and remove this Session",
    };
  }
  return session.closable ? {
    command: "close",
    label: "Remove Session",
    detail: "Remove this stopped Session",
  } : undefined;
}

function coordinationActions(
  session: SessionDto,
  sessions: readonly SessionDto[],
  capabilities: readonly AgentCapabilityDto[],
): SessionCoordinationActions | undefined {
  if (session.kind !== "Agent"
    || session.lifecycle_state !== "running"
    || !matchesInteractiveAgentProvider(session)
    || !capabilities.some((capability) => capability.agent_id === session.process.agent_id
      && capability.quick_action_supported)
    || isAssistantSession(session)
    || isImproverSession(session)
    || session.run_configuration_id !== null) {
    return undefined;
  }
  return {
    askTargets: capabilities
      .filter((capability): capability is AgentCapabilityDto & { agent_id: "claude" | "codex" } => (
        capability.available
        && capability.tracked_helpers_supported
        && (capability.agent_id === "claude" || capability.agent_id === "codex")
      ))
      .map((capability) => ({
        agentId: capability.agent_id,
        label: capability.agent_id === "claude" ? "Claude" : "Codex",
      })),
    handoverTargets: sessions.filter((candidate) => (
      candidate.id !== session.id
      && candidate.project_id === session.project_id
      && candidate.kind === "Agent"
      && candidate.lifecycle_state === "running"
      && matchesInteractiveAgentProvider(candidate)
      && capabilities.some((capability) => capability.agent_id === candidate.process.agent_id
        && capability.quick_action_supported)
      && !isAssistantSession(candidate)
      && !isImproverSession(candidate)
      && candidate.run_configuration_id === null
    )),
  };
}

function matchesInteractiveAgentProvider(session: SessionDto): boolean {
  return typeof session.process.agent_id === "string"
    && session.process.agent_id.length <= 64
    && /^[a-z](?:[a-z0-9]|-[a-z0-9])*$/u.test(session.process.agent_id);
}

function isImproverSession(session: SessionDto): boolean {
  const template = session.process.template_ref;
  return (template?.startsWith("builtin.improver.") ?? false)
    || template === "builtin.builder.playbook"
    || template === "builtin.builder.routine";
}

export function relocationBlockerMessage(blocker: SessionRelocationBlocker): string {
  const messages: Record<SessionRelocationBlocker, string> = {
    sourceNotRunning: "The source Agent is no longer running.",
    sourceNotOrdinaryAgent: "Only ordinary Claude or Codex Agents can be moved.",
    resumeRefMissing: "This Agent has no valid provider resume reference.",
    resumeCapabilityUnavailable: "This provider cannot resume this conversation.",
    freshHandoffUnsupported: "Starting fresh during a move is available only for Claude Agents.",
    askToInProgress: "Finish or cancel the current Ask-To request first.",
    sameProjectRequired: "The target Task must belong to the same Project.",
    taskNotOpen: "Reopen the Task before moving the Agent.",
    taskArchived: "Restore the Task before moving the Agent.",
    worktreeRequired: "Create this Task's worktree on your Mac first.",
    managedProofMissing: "The target worktree is not safely managed by TermLoop.",
    managedProofMismatch: "The target worktree identity changed; repair it first.",
    worktreeUnhealthy: "The target worktree did not pass its launch-readiness inspection.",
    sourceAlreadyTaskAttached: "This Agent is already attached to a Task.",
    alreadyInTargetWorktree: "This Agent already uses the selected worktree.",
    lifecycleInProgress: "Another Session or Task lifecycle operation is in progress.",
    launchReserved: "The target worktree is temporarily reserved by another launch.",
    sourceNotTaskAttached: "This Agent is not attached to a managed Task worktree.",
    projectRootUnavailable: "The Project checkout is unavailable.",
  };
  return messages[blocker];
}

export function relocationWarningMessage(warning: SessionRelocationWarning): string {
  const messages: Record<SessionRelocationWarning, string> = {
    taskLifecycleApplies: "The Task lifecycle will apply after this move.",
    crossCwdPathsMayBeStale: "Paths mentioned earlier may refer to the old checkout.",
    sourceTurnWillBeInterrupted: "The Agent's current turn will be interrupted.",
    targetHasActiveSessions: "The target already has active Sessions.",
    freshConversationWillStart: "A fresh provider conversation will start.",
    taskLifecycleNoLongerApplies: "The Task lifecycle will no longer apply after this move.",
  };
  return messages[warning];
}

export function relocationTargetLabel(task: TaskDto | null, projectName: string): string {
  return task?.title ?? projectName;
}
