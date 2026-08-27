import type { TaskDto, TaskWorktreeProvisioningFailureKind } from "@termloop/contract/current";

import {
  taskCheckedOutBranch,
  taskHasWorktreeChanges,
  taskWorktreeInlineAction,
} from "./dto-readers";
import type { AgentAttention } from "./session-presentation";
import { strongerTone, type RowTone } from "./tone";

/// Task row and Task detail composition, ported from the desktop's
/// `renderer/task-presentation.ts`. The mobile surface is read-only, so the
/// desktop's next-step affordances become sentences that name the Mac as the place
/// to act rather than buttons the phone cannot honour.

export type TaskStageTone = Extract<RowTone, "quiet" | "busy" | "blocked">;

/// Structural position of a Task: what exists, not what an agent is doing. Keeping
/// agent liveness out of the stage means the stage word does not change when the
/// same Task is read on a different surface.
export type TaskStageId =
  | "closed"
  | "planning"
  | "branchOnly"
  | "provisioning"
  | "provisioningFailed"
  | "repair"
  | "unavailable"
  | "ready";

const stagePresentation: Record<TaskStageId, {
  tone: TaskStageTone;
  flag: string | undefined;
  headline: string;
}> = {
  closed: { tone: "quiet", flag: undefined, headline: "Closed. Its current state is kept." },
  planning: { tone: "quiet", flag: undefined, headline: "No branch yet." },
  branchOnly: { tone: "quiet", flag: undefined, headline: "A branch is bound, with no worktree." },
  provisioning: { tone: "busy", flag: "Creating", headline: "Creating the worktree." },
  provisioningFailed: { tone: "blocked", flag: "Failed", headline: "Worktree creation failed." },
  repair: { tone: "blocked", flag: "Needs repair", headline: "The worktree link is stale or moved." },
  unavailable: { tone: "blocked", flag: "Unavailable", headline: "Agents cannot start here." },
  ready: { tone: "quiet", flag: undefined, headline: "Ready to run agents." },
};

export type TaskStage = {
  id: TaskStageId;
  tone: TaskStageTone;
  flag: string | undefined;
  /// The stage headline plus its note when it has one. Used for the accessible
  /// name and the detail screen's worktree body.
  summary: string;
  note: string | undefined;
};

export interface TaskGlanceAgent {
  readonly title: string;
  readonly stateLabel: string;
  readonly tone: RowTone;
}

/// The plain-language answer shown before any branch, worktree, or pipeline detail.
/// Agent attention wins over structural setup because it is the one thing the user
/// can act on immediately from the phone.
export function taskAtAGlance(
  stage: TaskStage,
  agents: readonly TaskGlanceAgent[],
): { title: string; detail: string; tone: RowTone } {
  const attention = agents.find((agent) => (
    agent.tone === "attention" || agent.tone === "blocked" || agent.tone === "review"
  ));
  if (attention !== undefined) {
    return {
      title: `${attention.title}: ${attention.stateLabel}`,
      detail: "Open the agent below to review its work or answer it.",
      tone: attention.tone,
    };
  }
  if (agents.length > 0) {
    return {
      title: `${agents.length} active ${agents.length === 1 ? "agent" : "agents"}`,
      detail: "Work is in progress. Open an agent below to see its latest output.",
      tone: "working",
    };
  }
  switch (stage.id) {
    case "closed":
      return { title: "Task closed", detail: "Its current work is kept for reference.", tone: stage.tone };
    case "provisioning":
      return { title: "Preparing the workspace", detail: "You can start an agent when setup finishes.", tone: stage.tone };
    case "provisioningFailed":
    case "repair":
    case "unavailable":
      return { title: "Needs attention on your Mac", detail: stage.summary, tone: stage.tone };
    case "planning":
    case "branchOnly":
      return { title: "Setup needed", detail: "Create a workspace on your Mac before starting an agent.", tone: stage.tone };
    case "ready":
      return { title: "Ready to start", detail: "No agent is working on this task yet.", tone: stage.tone };
  }
}

function stageOf(id: TaskStageId, note?: string): TaskStage {
  const entry = stagePresentation[id];
  return {
    id,
    tone: entry.tone,
    flag: entry.flag,
    summary: note ? `${entry.headline} ${note}` : entry.headline,
    note,
  };
}

const provisioningFailureNotes: Record<TaskWorktreeProvisioningFailureKind, string> = {
  gitUnavailable: "Git is not available on that machine.",
  unsupportedGit: "The installed Git is too old to create worktrees.",
  permissionDenied: "TermLoop cannot write to the destination folder.",
  repositoryUnavailable: "The repository could not be opened.",
  branchConflict: "Another checkout already has this branch.",
  pathConflict: "The destination folder is already in use.",
  worktreeLocked: "Git reports this worktree as locked.",
  timeout: "Worktree creation timed out.",
  outputLimit: "Git produced more output than TermLoop reads.",
  recoveryAttention: "An interrupted attempt needs an exact retry.",
  operationFailed: "Git refused to create the worktree.",
};

/// The map is total over the generated union, so a new contract member fails this
/// client's type check instead of reaching a user as an identifier. The lookup is
/// still guarded: a daemon running ahead of this build can put a kind on the wire
/// that this app has never heard of, and a missing sentence would leave a blocked
/// Task with a bare "Failed" and no explanation.
export function provisioningFailureNote(kind: TaskWorktreeProvisioningFailureKind | undefined): string {
  return (kind ? provisioningFailureNotes[kind] as string | undefined : undefined)
    ?? provisioningFailureNotes.operationFailed;
}

/// Why a present worktree cannot host a launch. Five independent enums rather than
/// one union, so exhaustiveness is not expressible; the final sentence is an honest
/// fallback, not a silent hole.
///
/// An interrupted folder deletion is checked before health because health can only
/// describe what the checkout looks like now. A half-removed folder is
/// indistinguishable from an ordinary unhealthy one, and reporting it as unproven
/// hides both the cause and the one action that finishes it.
function unavailableNote(task: TaskDto): string {
  const disposal = task.worktree_stale_resolution;
  if (disposal?.mode === "discardDirectory"
    && disposal.status === "failed"
    && disposal.failure?.kind === "recoveryAttention") {
    return "A folder deletion was interrupted, so this checkout is partly removed. Delete the Task again to finish it.";
  }
  const health = task.worktree_health;
  if (!health) return "TermLoop has not observed this worktree yet.";
  if (health.head_state === "mismatch") return "The checkout HEAD does not match its registration.";
  if (health.head_state === "missing") return "The checkout has no resolvable HEAD.";
  if (health.path_state === "replaced") return "Another filesystem entry now sits at this path.";
  if (health.index_lock_state === "present") return "Git is holding the index lock in this checkout.";
  if (health.worktree_lock_state === "present") return "This worktree is locked.";
  return "TermLoop cannot prove this checkout is safe to launch in.";
}

export function taskStage(task: TaskDto): TaskStage {
  if (task.status === "closed") return stageOf("closed");
  const provisioning = task.worktree_provisioning;
  if (provisioning?.status === "running") return stageOf("provisioning");
  if (provisioning?.status === "failed") {
    return stageOf("provisioningFailed", provisioningFailureNote(provisioning.failure?.kind));
  }
  if (!task.worktree) return stageOf(task.branch ? "branchOnly" : "planning");
  const action = taskWorktreeInlineAction(task);
  if (action === "repair") return stageOf("repair", "Its registered folder no longer matches this Task.");
  if (action === "unavailable") return stageOf("unavailable", unavailableNote(task));
  return stageOf("ready");
}

/// The spine colour for a whole Task row: its structural stage, or the agents
/// running inside it, whichever is louder.
export function taskRowTone(stage: TaskStage, attention: AgentAttention | undefined): RowTone {
  return attention ? strongerTone(stage.tone, attention.tone) : stage.tone;
}

/// The read-only counterpart of the desktop's next step. Every recovery a Task
/// needs happens on the Mac, so the phone names the place instead of offering a
/// control it must then refuse.
export function taskRemoteActionNote(stage: TaskStage): string | undefined {
  switch (stage.id) {
    case "planning":
    case "branchOnly":
      return "Create a worktree on your Mac to run agents here.";
    case "provisioningFailed":
      return "Retry worktree creation on your Mac.";
    case "repair":
      return "Repair this worktree on your Mac.";
    case "unavailable":
      return "Resolve this worktree on your Mac.";
    case "closed":
    case "provisioning":
    case "ready":
      return undefined;
  }
}

export function taskChangeCount(task: TaskDto): number | undefined {
  if (!taskHasWorktreeChanges(task)) return undefined;
  const count = task.worktree_health?.change_count ?? 0;
  return count > 0 ? count : undefined;
}

export function taskChangeLabel(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

const upstreamNotes = {
  inSync: "in sync with origin",
  behind: "behind origin",
  ahead: "ahead of origin",
  diverged: "diverged from origin",
  notConfigured: "no upstream configured",
  missing: "upstream branch is missing",
  unknown: "upstream state unknown",
} as const;

/// The branch section's second line: whether the checkout is clean, and how it sits
/// against its upstream. Both are already-observed facts; the phone never asks Git.
export function taskBranchNote(task: TaskDto): string | undefined {
  const health = task.worktree_health;
  if (!health) return undefined;
  const changes = taskChangeCount(task);
  const cleanliness = changes === undefined ? "clean" : taskChangeLabel(changes);
  return `${cleanliness} · ${upstreamNotes[health.upstream_state]}`;
}

/// A different local branch in the checkout is launchable but easy to mistake for
/// the Task branch, so it reads as a warning rather than another neutral token.
export function taskDivergenceNote(task: TaskDto): string | undefined {
  const branch = taskCheckedOutBranch(task);
  if (!branch) return undefined;
  return `This checkout currently has ${branch} checked out, not the Task branch ${task.branch?.name ?? "(unbound)"}.`;
}

export function taskPresenceNote(task: TaskDto): string | undefined {
  const presence = task.worktree_presence;
  if (!presence || presence.total_count === 0) return undefined;
  const count = presence.total_count;
  return `${count} attached ${count === 1 ? "session" : "sessions"}`;
}
