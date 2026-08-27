import type {
  AgentStatusDto,
  GitHostTaskProjectionDto,
  ProjectDto,
  ProjectWorktreeSummaryDto,
  SessionDto,
  RunConfigurationDto,
  RunRuntimeEntryDto,
  TaskDto,
  TaskWorktreeChangeEntryDto,
  TaskWorktreeCleanupBlocker,
  TaskWorktreeCleanupPreviewDto,
  TaskWorktreeCleanupWarning,
  TaskWorktreeStaleResolutionBlocker,
  TaskBranchCommitSummaryDto,
} from "@termloop/contract/current";
import type { ConnectionScope } from "../connection-scope.js";

export type Project = ProjectDto & ConnectionScope;
export type ProjectWorktreeSummary = ProjectWorktreeSummaryDto;
export type Session = SessionDto & ConnectionScope;
export type RunConfiguration = RunConfigurationDto;
export type RunRuntime = RunRuntimeEntryDto;
export type AgentStatus = AgentStatusDto & ConnectionScope;
export type Task = TaskDto & ConnectionScope;
export type GitHostProjection = GitHostTaskProjectionDto;
export type BranchCommitSummary = TaskBranchCommitSummaryDto;

export function automaticBranchCommitTaskIds(tasks: readonly Task[]): string[] {
  return tasks.filter((task) => task.branch !== null).map((task) => task.id);
}

export function automaticGitHostTaskIds(tasks: readonly Task[]): string[] {
  return tasks
    .filter((task) => task.status === "open" && task.branch !== null)
    .map((task) => task.id);
}

export type ConnectionState = "connecting" | "connected" | "connectionLost" | "daemonUnavailable";

export function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

/// Terminating a Session keeps its descriptor so it can be resumed or cleared,
/// so the rail's count has to ask what is actually live rather than how many
/// records exist.
export function isLiveSession(session: Session): boolean {
  return session.lifecycle_state === "running" || session.lifecycle_state === "resuming";
}

/// An improver is identified by inspected launch provenance, never by its
/// user-editable Session name.
export function sessionIsImprover(session: Session): boolean {
  if (session.kind !== "Agent") return false;
  const templateRef = session.process.template_ref;
  return (templateRef?.startsWith("builtin.improver.") ?? false)
    || templateRef === "builtin.builder.playbook"
    || templateRef === "builtin.builder.routine";
}

/// Every current, non-archived Session keeps its terminal surface until an
/// explicit user action closes the Session descriptor. Process exit changes
/// lifecycle and input availability; it never dismisses the terminal itself.
export function sessionKeepsTerminalSurface(session: Session): boolean {
  return session.archived_at_epoch_ms === null;
}

/// Selects the first daemon command for one rail close intent. Live Sessions
/// are terminated before being forgotten, while stopped descriptors close
/// directly. A retryable ownership failure routes through termination first.
export function sessionDismissCommand(session: Session): "terminate" | "close" | undefined {
  if (session.lifecycle_state === "running" || session.lifecycle_state === "resuming") return "terminate";
  if (session.lifecycle_state === "resumeFailed" && session.retryable && !session.closable) return "terminate";
  return session.closable ? "close" : undefined;
}

/// The daemon's `retryable` projection means an explicit retry is available.
/// Use one verb for both a clean exit and a failed prior attempt: from the
/// user's perspective both replace the stopped provider inside this Session.
export function sessionResumeActionLabel(session: Session): "Retry" | undefined {
  if (!session.retryable) return undefined;
  return "Retry";
}

export function agentName(session: Session): string {
  const id = session.process.agent_id;
  return id ? `${id.slice(0, 1).toUpperCase()}${id.slice(1)}` : "Agent";
}

export function sessionLabel(session: Session): string {
  const name = session.name?.trim();
  if (name) return name;
  if (session.kind === "Agent") return agentName(session);
  return basename(session.process.cwd) || "Terminal";
}

export function taskJiraIssueKey(jiraUrl: string): string {
  return jiraUrl.slice(jiraUrl.lastIndexOf("/") + 1);
}

export function taskCheckedOutBranch(task: Task): string | undefined {
  const checkedOutBranch = task.worktree_health?.checked_out_branch ?? undefined;
  return checkedOutBranch && checkedOutBranch !== task.branch?.name ? checkedOutBranch : undefined;
}

/// V1 reuses the bounded health scheduler's tri-state instead of adding a
/// recurring per-Task status/count query solely for presentation.
export function taskHasWorktreeChanges(task: Task): boolean {
  const health = task.worktree_health;
  return health?.staged_state === "changed"
    || health?.tracked_state === "changed"
    || health?.untracked_state === "present";
}

export function taskWorktreeChangeNeedsDiff(
  entry: Pick<TaskWorktreeChangeEntryDto, "render_state"> | undefined,
): boolean {
  return entry?.render_state === "available";
}

export function relativeTaskWorktreeChangeEntryId(
  entries: readonly Pick<TaskWorktreeChangeEntryDto, "entry_id" | "side">[],
  selectedId: string | undefined,
  offset: -1 | 1,
): string | undefined {
  if (entries.length === 0) return undefined;
  const sideOrder: Record<TaskWorktreeChangeEntryDto["side"], number> = {
    staged: 0,
    unstaged: 1,
    untracked: 2,
  };
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => sideOrder[left.entry.side] - sideOrder[right.entry.side] || left.index - right.index)
    .map(({ entry }) => entry);
  const selectedIndex = ordered.findIndex((entry) => entry.entry_id === selectedId);
  const currentIndex = selectedIndex >= 0 ? selectedIndex : offset > 0 ? -1 : 0;
  const nextIndex = (currentIndex + offset + ordered.length) % ordered.length;
  return ordered[nextIndex]?.entry_id;
}

export function taskWorktreePresenceLabel(task: Task): string {
  if (!task.worktree) return "presence not applicable";
  const presence = task.worktree_presence;
  if (!presence) return "presence unknown";
  if (presence.total_count === 0) return "no attached sessions";
  const suffix = presence.truncated ? "+" : "";
  return `${presence.total_count}${suffix} attached · ${presence.terminal_count} terminals · ${presence.agent_count} agents`;
}

export function canDismissTaskWorktreeProvisioning(task: Task): boolean {
  return task.worktree_provisioning?.status === "failed"
    && task.worktree_provisioning.failure?.kind !== "recoveryAttention";
}

export function taskWorktreeCleanupOperationId(
  task: Task,
  cleanupMode: "safe" | "discardCheckoutContent",
  acknowledgedContentBlockers: TaskWorktreeCleanupBlocker[],
  freshId: () => string,
): string {
  const failed = task.worktree_cleanup?.status === "failed" ? task.worktree_cleanup : undefined;
  return failed
    && failed.cleanup_mode === "safe"
    && failed.cleanup_mode === cleanupMode
    && failed.acknowledged_content_blockers.length === acknowledgedContentBlockers.length
    && failed.acknowledged_content_blockers.every((blocker) => acknowledgedContentBlockers.includes(blocker))
    ? failed.operation_id
    : freshId();
}

const taskDeleteContentBlockers = new Set<TaskWorktreeCleanupBlocker>([
  "trackedChanges",
  "stagedChanges",
  "untrackedContent",
  "ignoredContent",
  "submodulePresent",
]);

export const TASK_DELETE_SESSION_BATCH_CAP = 64;
export const TASK_DELETE_SESSION_MAX_ROUNDS = 8;

export type TaskDeleteSessionRetirementGate =
  | { status: "notNeeded"; sessionIds: readonly [] }
  | { status: "allowed"; sessionIds: readonly string[]; contentBlockers: readonly TaskWorktreeCleanupBlocker[] }
  | { status: "blocked"; sessionIds: readonly string[] };

export function taskDeleteSessionRetirementGate(
  preview: TaskWorktreeCleanupPreviewDto,
): TaskDeleteSessionRetirementGate {
  if (!preview.blockers.includes("sessionAttached")) return { status: "notNeeded", sessionIds: [] };
  const sessionIds = preview.presence?.attached_sessions.map((session) => session.session_id) ?? [];
  const hardBlocker = preview.blockers.some(
    (blocker) => blocker !== "sessionAttached" && !taskDeleteContentBlockers.has(blocker),
  );
  if (preview.decision === "unknown"
    || hardBlocker
    || !preview.presence
    || sessionIds.length === 0
    || sessionIds.length > TASK_DELETE_SESSION_BATCH_CAP) {
    return { status: "blocked", sessionIds };
  }
  return {
    status: "allowed",
    sessionIds,
    contentBlockers: preview.blockers.filter((blocker) => taskDeleteContentBlockers.has(blocker)),
  };
}

export function taskDeletePreviewCanProceed(preview: TaskWorktreeCleanupPreviewDto): boolean {
  if (preview.stale_resolution.forget_status === "available") return true;
  if (preview.stale_resolution.disposal_status === "available"
    || preview.stale_resolution.disposal_status === "sessionRetirementRequired") {
    return true;
  }
  if (preview.decision === "allowed" || preview.destructive_cleanup.status === "available") {
    return true;
  }
  return taskDeleteSessionRetirementGate(preview).status === "allowed";
}

export type TaskDeleteSessionBatch =
  | { status: "complete" }
  | { status: "ready"; sessionIds: readonly string[] }
  | { status: "blocked"; reason: "gate" | "roundLimit" | "noProgress" };

export function taskDeleteSessionBatch(
  preview: TaskWorktreeCleanupPreviewDto,
  retiredSessionIds: ReadonlySet<string>,
  completedRounds: number,
): TaskDeleteSessionBatch {
  const gate = taskDeleteSessionRetirementGate(preview);
  if (gate.status === "notNeeded") return { status: "complete" };
  if (gate.status === "blocked") return { status: "blocked", reason: "gate" };
  if (completedRounds >= TASK_DELETE_SESSION_MAX_ROUNDS) {
    return { status: "blocked", reason: "roundLimit" };
  }
  const next = gate.sessionIds.filter((sessionId) => !retiredSessionIds.has(sessionId));
  return next.length > 0
    ? { status: "ready", sessionIds: next }
    : { status: "blocked", reason: "noProgress" };
}

export function taskDeleteTerminationNotFoundSatisfied(
  preview: TaskWorktreeCleanupPreviewDto,
  sessionId: string,
): boolean {
  return Boolean(preview.presence
    && !preview.presence.truncated
    && !preview.presence.attached_sessions.some((session) => session.session_id === sessionId));
}

export type TaskDeleteWorktreeReview =
  | {
      preview: TaskWorktreeCleanupPreviewDto;
      kind: "cleanup";
    }
  | {
      preview: TaskWorktreeCleanupPreviewDto;
      kind: "forgetStaleBinding" | "discardStaleDirectory";
    };

export type TaskDeleteWorktreeResult =
  | { status: "completed"; message?: string }
  | { status: "reviewRequired"; preview: TaskWorktreeCleanupPreviewDto; message: string }
  | { status: "failed"; message: string };

const cleanupBlockerMessages: Record<TaskWorktreeCleanupBlocker, string> = {
  noBinding: "This Task no longer has a worktree binding. Refresh the Task before trying again.",
  provisioningInProgress: "Worktree creation is still running. Wait for it to finish before cleanup.",
  cleanupInProgress: "A cleanup operation is already running for this worktree.",
  managedProofMissing: "TermLoop cannot prove that it created and owns this worktree, so it will not delete the directory.",
  managedProofMismatch: "The managed worktree changed after this inspection. Inspect the current worktree again.",
  pathReplaced: "The worktree path now points to a different filesystem entry. TermLoop will not delete it.",
  pathRegistrationInconsistent: "The directory and Git worktree registration disagree. Repair the worktree link before cleanup.",
  orphanedManagedDirectory: "Git no longer registers this exact managed directory. You can keep the folder and forget its Task binding, or separately acknowledge deletion of the unverified folder.",
  registrationMismatch: "Git registration does not match this managed worktree. Repair the worktree link before cleanup.",
  branchMismatch: "Git reports a different branch for this worktree than the Task expects.",
  headMismatch: "The checked-out HEAD no longer matches the Task's managed branch.",
  sessionAttached: "A Terminal or agent is still running in this worktree. Close those Sessions and inspect again.",
  trackedChanges: "Tracked files contain uncommitted changes. Commit, stash, move, or discard them manually first.",
  stagedChanges: "The Git index contains staged changes. Commit or unstage them before cleanup.",
  untrackedContent: "Untracked files are present. Move, commit, or delete them manually before cleanup.",
  ignoredContent: "Git-ignored files are present, such as .env, node_modules, or target. TermLoop will not delete them automatically; review and remove or move them manually, then inspect again.",
  submodulePresent: "An initialized submodule is present. Destructive cleanup also permanently deletes its checkout-local content.",
  worktreeLock: "Git has locked this worktree. Remove the lock intentionally before cleanup.",
  indexLock: "The Git index is locked, possibly by another Git process. Wait for it to finish and inspect again.",
  repositoryUnavailable: "The repository could not be inspected. Confirm that the repository and worktree still exist.",
  permissionDenied: "TermLoop does not have permission to inspect or remove this worktree.",
  unsupportedGit: "The installed Git version does not support the required safe cleanup checks.",
  timeout: "Git inspection timed out. No files were removed; try again after the repository becomes responsive.",
  outputLimit: "Git returned more inspection data than TermLoop can safely process.",
  observationFailed: "TermLoop could not prove that cleanup is safe. No files were removed.",
  recoveryAttention: "A previous cleanup may have been interrupted. Resolve or retry that operation before starting another cleanup.",
};

const cleanupWarningMessages: Record<TaskWorktreeCleanupWarning, string> = {
  upstreamBehind: "The branch is behind its upstream branch. This does not block cleanup because the local branch is kept.",
  upstreamAhead: "The branch has commits not present upstream. This does not block cleanup because the local branch is kept.",
  upstreamDiverged: "The local and upstream branches have diverged. This does not block cleanup because the local branch is kept.",
  upstreamNotConfigured: "This branch does not track a remote branch. This is informational only; cleanup keeps the local branch.",
  upstreamMissing: "The configured upstream branch no longer exists. This is informational only; cleanup keeps the local branch.",
  upstreamUnknown: "The upstream state could not be determined. This is informational only; cleanup keeps the local branch.",
};

const destructiveCleanupBlockerMessages: Partial<Record<TaskWorktreeCleanupBlocker, string>> = {
  trackedChanges: "These tracked changes will be permanently deleted.",
  stagedChanges: "These staged changes will be permanently deleted.",
  untrackedContent: "These untracked files will be permanently deleted.",
  ignoredContent: "Ignored content such as .env, node_modules, and target will be permanently deleted.",
  submodulePresent: "Initialized submodule checkout content will be permanently deleted.",
};

export function taskWorktreeCleanupBlockerMessage(
  blocker: TaskWorktreeCleanupBlocker,
  destructive = false,
): string {
  if (destructive && destructiveCleanupBlockerMessages[blocker]) {
    return destructiveCleanupBlockerMessages[blocker];
  }
  return cleanupBlockerMessages[blocker];
}

export function taskWorktreeCleanupWarningMessage(warning: TaskWorktreeCleanupWarning): string {
  return cleanupWarningMessages[warning];
}

const staleResolutionBlockerMessages: Record<TaskWorktreeStaleResolutionBlocker, string> = {
  noBinding: "This Task no longer has a worktree path.",
  managedProofMissing: "The original managed-worktree proof is missing; only the explicitly acknowledged stale path flow can proceed.",
  managedProofMismatch: "The managed-worktree identity changed after inspection.",
  provisioningInProgress: "Worktree creation is still in progress.",
  cleanupInProgress: "Another worktree cleanup is still in progress.",
  repairInProgress: "Worktree repair is still in progress.",
  staleDisposalInProgress: "A stale-worktree deletion operation is already in progress.",
  repositoryUnavailable: "The repository could not be inspected reliably.",
  commonRepositoryChanged: "The repository identity changed after inspection.",
  pathAbsent: "The recorded path is absent and is not a recoverable completed deletion.",
  pathReplaced: "The recorded path now resolves to a different filesystem entry.",
  registrationPresent: "Git still registers this path in a way that does not exactly match the Task branch.",
  branchMissing: "The Task branch no longer resolves in the repository.",
  gitMetadataPresent: "An unexpected .git file or directory is present, so recursive folder deletion is refused.",
  sessionAttached: "A Terminal or Agent Session is still attached to this path.",
  protectedPath: "This path overlaps a Project, repository, daemon state, another Task worktree, home, root, or mount boundary.",
  permissionDenied: "TermLoop does not have permission to inspect or remove this path.",
  timeout: "Safety inspection timed out; nothing was deleted.",
  observationFailed: "TermLoop could not prove the stale path is eligible; nothing was deleted.",
  recoveryAttention: "A previous deletion was interrupted and requires an exact recovery retry.",
};

export function taskWorktreeStaleResolutionBlockerMessage(
  blocker: TaskWorktreeStaleResolutionBlocker,
): string {
  return staleResolutionBlockerMessages[blocker];
}

export type TaskWorktreeInlineAction = "create" | "launch" | "repair" | "unavailable";

export function taskWorktreeInlineAction(task: Task): TaskWorktreeInlineAction {
  if (!task.worktree) return "create";
  const health = task.worktree_health;
  if (health?.launch_ready) return "launch";
  if (health?.path_state === "absent" || health?.registration_state === "mismatch") return "repair";
  return "unavailable";
}
