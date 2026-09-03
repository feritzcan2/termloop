import { describe, expect, it } from "vitest";
import type { TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import type { Task } from "../src/renderer/model.js";
import {
  TASK_DELETE_SESSION_MAX_ROUNDS,
  canDismissTaskWorktreeProvisioning,
  automaticBranchCommitTaskIds,
  automaticGitHostTaskIds,
  taskDeleteSessionBatch,
  taskDeletePreviewCanProceed,
  taskDeleteSessionRetirementGate,
  taskDeleteTerminationNotFoundSatisfied,
  relativeTaskWorktreeChangeEntryId,
  taskCheckedOutBranch,
  taskEffectiveBranch,
  taskHasWorktreeChanges,
  taskJiraIssueKey,
  taskWorktreeChangeNeedsDiff,
  taskWorktreeCleanupBlockerMessage,
  taskWorktreeCleanupOperationId,
  taskWorktreeCleanupWarningMessage,
  taskWorktreeInlineAction,
  taskWorktreePresenceLabel,
} from "../src/renderer/model.js";

function cleanupPreview(
  blockers: TaskWorktreeCleanupPreviewDto["blockers"],
  decision: TaskWorktreeCleanupPreviewDto["decision"] = "refused",
): TaskWorktreeCleanupPreviewDto {
  return {
    task_id: "task-1",
    managed_worktree_operation_id: "proof-1",
    worktree_generation: 1,
    target_path: "/worktree",
    decision,
    blockers,
    warnings: [],
    health: null,
    presence: {
      observation_sequence: 1,
      observed_at_epoch_ms: 1,
      attached_sessions: [{ session_id: "session-1", kind: "Agent" }],
      total_count: 1,
      terminal_count: 0,
      agent_count: 1,
      truncated: false,
    },
    destructive_cleanup: { status: "unavailable", eligible_blockers: [] },
    stale_resolution: { forget_status: "unavailable", disposal_status: "unavailable", blockers: [] },
  };
}

describe("Task presentation metadata", () => {
  it("automatically queries only open branch-bound Tasks for Git-host projections", () => {
    const base = {
      project_id: "project-1",
      title: "Projection",
      brief: null,
      jira_url: null,
      archived_at_epoch_ms: null,
      worktree: null,
      rank: 0,
      created_at_epoch_ms: 1,
      updated_at_epoch_ms: 2,
    } satisfies Omit<Task, "id" | "status" | "branch">;
    const tasks: Task[] = [
      { ...base, id: "open-bound", status: "open", branch: { repository_root: "/repo", name: "feature" } },
      { ...base, id: "open-unbound", status: "open", branch: null },
      { ...base, id: "closed-bound", status: "closed", branch: { repository_root: "/repo", name: "done" } },
    ];
    expect(automaticGitHostTaskIds(tasks)).toEqual(["open-bound"]);
    expect(automaticBranchCommitTaskIds(tasks)).toEqual(["open-bound", "closed-bound"]);
  });

  it("keeps branch identity in the accessible name when a brief is present", () => {
    const task: Task = {
      id: "task-1",
      project_id: "project-1",
      title: "Ship binding",
      brief: "Brief remains visible",
      jira_url: null,
      archived_at_epoch_ms: null,
      status: "open",
      branch: { repository_root: "/repository", name: "feature/binding" },
      worktree: null,
      rank: 0,
      created_at_epoch_ms: 1,
      updated_at_epoch_ms: 2,
    };

    expect(taskCheckedOutBranch(task)).toBeUndefined();
    expect(taskEffectiveBranch(task)).toBe("feature/binding");
    expect(taskWorktreeInlineAction(task)).toBe("create");
  });

  it("exposes the derived Jira sidecar without treating it as Task authority", () => {
    const task: Task = {
      id: "task-1",
      project_id: "project-1",
      title: "Ship Jira link",
      brief: null,
      jira_url: "https://example.atlassian.net/browse/TERM-42",
      archived_at_epoch_ms: null,
      status: "open",
      branch: null,
      worktree: null,
      rank: 0,
      created_at_epoch_ms: 1,
      updated_at_epoch_ms: 2,
    };

    expect(taskJiraIssueKey(task.jira_url!)).toBe("TERM-42");
  });

  it("keeps live presence accessible without exposing the health summary", () => {
    const task: Task = {
      id: "task-1",
      project_id: "project-1",
      title: "Observed checkout",
      brief: null,
      jira_url: null,
      archived_at_epoch_ms: null,
      status: "open",
      branch: { repository_root: "/repository", name: "feature/observed" },
      worktree: { path: "/worktree" },
      worktree_generation: 1,
      worktree_health: {
        observation_sequence: 10,
        observed_at_epoch_ms: 9_000,
        path_state: "present",
        registration_state: "matching",
        head_state: "matching",
        launch_ready: true,
        checked_out_branch: "feature/observed",
        change_count: 0,
        tracked_state: "clean",
        staged_state: "clean",
        untracked_state: "absent",
        ignored_state: "absent",
        submodule_state: "absent",
        worktree_lock_state: "absent",
        index_lock_state: "absent",
        upstream_state: "inSync",
        summary: "healthy",
      },
      worktree_presence: {
        observation_sequence: 11,
        observed_at_epoch_ms: 9_000,
        attached_sessions: [{ session_id: "session-1", kind: "Terminal" }],
        total_count: 1,
        terminal_count: 1,
        agent_count: 0,
        truncated: false,
      },
      rank: 0,
      created_at_epoch_ms: 1,
      updated_at_epoch_ms: 2,
    };
    expect(taskWorktreePresenceLabel(task)).toBe("1 attached · 1 terminals · 0 agents");
    expect(taskWorktreeInlineAction(task)).toBe("launch");
  });

  it("gates the Changes launcher on health and carries its existing status-derived count", () => {
    const base = {
      id: "task-changes",
      project_id: "project-1",
      title: "Changes",
      brief: null,
      jira_url: null,
      archived_at_epoch_ms: null,
      status: "open",
      branch: { repository_root: "/repository", name: "feature" },
      worktree: { path: "/worktree" },
      worktree_generation: 1,
      rank: 0,
      created_at_epoch_ms: 1,
      updated_at_epoch_ms: 2,
    } satisfies Omit<Task, "worktree_health">;
    const health = {
      observation_sequence: 1, observed_at_epoch_ms: 1, path_state: "present" as const,
      registration_state: "matching" as const, head_state: "matching" as const,
      launch_ready: true, checked_out_branch: "feature",
      change_count: 0,
      tracked_state: "clean" as const, staged_state: "clean" as const,
      untracked_state: "absent" as const, ignored_state: "absent" as const,
      submodule_state: "absent" as const, worktree_lock_state: "absent" as const,
      index_lock_state: "absent" as const, upstream_state: "inSync" as const,
      summary: "healthy" as const,
    };
    expect(taskHasWorktreeChanges({ ...base, worktree_health: health })).toBe(false);
    expect(taskHasWorktreeChanges({ ...base, worktree_health: { ...health, change_count: 1, staged_state: "changed" } })).toBe(true);
    expect(taskHasWorktreeChanges({ ...base, worktree_health: { ...health, change_count: 2, untracked_state: "present" } })).toBe(true);
  });

  it("does not request Git diffs for entries declared not shown", () => {
    expect(taskWorktreeChangeNeedsDiff({ render_state: "available" })).toBe(true);
    expect(taskWorktreeChangeNeedsDiff({ render_state: "notShown" })).toBe(false);
    expect(taskWorktreeChangeNeedsDiff(undefined)).toBe(false);
  });

  it("moves change selection in rendered section order and wraps at the ends", () => {
    const entries = [
      { entry_id: "unstaged-1", side: "unstaged" as const },
      { entry_id: "staged-1", side: "staged" as const },
      { entry_id: "untracked-1", side: "untracked" as const },
      { entry_id: "staged-2", side: "staged" as const },
    ];
    expect(relativeTaskWorktreeChangeEntryId(entries, "staged-1", 1)).toBe("staged-2");
    expect(relativeTaskWorktreeChangeEntryId(entries, "staged-1", -1)).toBe("untracked-1");
    expect(relativeTaskWorktreeChangeEntryId(entries, "untracked-1", 1)).toBe("staged-1");
    expect(relativeTaskWorktreeChangeEntryId(entries, undefined, 1)).toBe("staged-1");
    expect(relativeTaskWorktreeChangeEntryId([], undefined, 1)).toBeUndefined();
  });

  it("shows create, repair, and unavailable actions only for their exact health states", () => {
    const base = {
      id: "task-action",
      project_id: "project-1",
      title: "Action",
      brief: null,
      jira_url: null,
      archived_at_epoch_ms: null,
      status: "open",
      branch: null,
      rank: 0,
      created_at_epoch_ms: 1,
      updated_at_epoch_ms: 2,
    } satisfies Omit<Task, "worktree">;
    expect(taskWorktreeInlineAction({ ...base, worktree: null })).toBe("create");
    expect(taskWorktreeInlineAction({ ...base, worktree: { path: "/missing" }, worktree_health: {
      observation_sequence: 1, observed_at_epoch_ms: 1, path_state: "absent",
      registration_state: "unknown", head_state: "unknown", launch_ready: false,
      checked_out_branch: null, change_count: null, tracked_state: "unknown",
      staged_state: "unknown", untracked_state: "unknown", ignored_state: "unknown",
      submodule_state: "unknown", worktree_lock_state: "unknown", index_lock_state: "unknown",
      upstream_state: "unknown", summary: "attention",
    } })).toBe("repair");
    expect(taskWorktreeInlineAction({ ...base, worktree: { path: "/unknown" } })).toBe("unavailable");
  });

  it("keeps an alternate attached checkout branch launchable and exposes it separately", () => {
    const task: Task = {
      id: "task-alternate",
      project_id: "project-1",
      title: "Alternate checkout",
      brief: null,
      jira_url: null,
      archived_at_epoch_ms: null,
      status: "open",
      branch: { repository_root: "/repository", name: "feature/task" },
      worktree: { path: "/worktree" },
      worktree_generation: 1,
      worktree_health: {
        observation_sequence: 2,
        observed_at_epoch_ms: 2,
        path_state: "present",
        registration_state: "matching",
        head_state: "mismatch",
        launch_ready: true,
        checked_out_branch: "agent/current-work",
        change_count: 0,
        tracked_state: "clean",
        staged_state: "clean",
        untracked_state: "absent",
        ignored_state: "absent",
        submodule_state: "absent",
        worktree_lock_state: "absent",
        index_lock_state: "absent",
        upstream_state: "notConfigured",
        summary: "attention",
      },
      rank: 0,
      created_at_epoch_ms: 1,
      updated_at_epoch_ms: 2,
    };

    expect(taskWorktreeInlineAction(task)).toBe("launch");
    expect(taskCheckedOutBranch(task)).toBe("agent/current-work");
    expect(taskEffectiveBranch(task)).toBe("agent/current-work");
  });

  it("refuses to dismiss a failure that left recovery artifacts", () => {
    const task: Task = {
      id: "task-1",
      project_id: "project-1",
      title: "Recover checkout",
      brief: null,
      jira_url: null,
      archived_at_epoch_ms: null,
      status: "open",
      branch: null,
      worktree: null,
      worktree_provisioning: {
        operation_id: "operation-1",
        status: "failed",
        failure: { kind: "recoveryAttention" },
      },
      rank: 0,
      created_at_epoch_ms: 1,
      updated_at_epoch_ms: 2,
    };
    expect(canDismissTaskWorktreeProvisioning(task)).toBe(false);
  });

  it("allows dismissal only for failures without recovery artifacts", () => {
    const task: Task = {
      id: "task-1",
      project_id: "project-1",
      title: "Retry checkout",
      brief: null,
      jira_url: null,
      archived_at_epoch_ms: null,
      status: "open",
      branch: null,
      worktree: null,
      worktree_provisioning: {
        operation_id: "operation-1",
        status: "failed",
        failure: { kind: "pathConflict" },
      },
      rank: 0,
      created_at_epoch_ms: 1,
      updated_at_epoch_ms: 2,
    };
    expect(canDismissTaskWorktreeProvisioning(task)).toBe(true);
  });

  it("reuses a failed cleanup operation id instead of creating a dead-end retry", () => {
    const task = {
      id: "task-1",
      project_id: "project-1",
      title: "Retry cleanup",
      brief: null,
      jira_url: null,
      archived_at_epoch_ms: null,
      status: "open",
      branch: null,
      worktree: { path: "/worktree" },
      worktree_cleanup: {
        operation_id: "cleanup-1",
        managed_worktree_operation_id: "proof-1",
        worktree_generation: 1,
        stage: "removePrepared",
        status: "failed",
        cleanup_mode: "safe",
        acknowledged_content_blockers: [],
        failure: { kind: "removalFailed", blockers: [] },
      },
      rank: 0,
      created_at_epoch_ms: 1,
      updated_at_epoch_ms: 2,
    } satisfies Task;
    expect(taskWorktreeCleanupOperationId(task, "safe", [], () => "new-id")).toBe("cleanup-1");
    expect(taskWorktreeCleanupOperationId(task, "discardCheckoutContent", ["ignoredContent"], () => "new-id")).toBe("new-id");

    const destructiveTask: Task = {
      ...task,
      worktree_cleanup: {
        ...task.worktree_cleanup,
        cleanup_mode: "discardCheckoutContent",
        acknowledged_content_blockers: ["ignoredContent"],
        failure: { kind: "recoveryAttention", blockers: ["recoveryAttention"] },
      },
    };
    expect(taskWorktreeCleanupOperationId(destructiveTask, "discardCheckoutContent", ["ignoredContent"], () => "fresh-destructive-id"))
      .toBe("fresh-destructive-id");
  });

  it("explains cleanup blockers separately from informational upstream warnings", () => {
    expect(taskWorktreeCleanupBlockerMessage("ignoredContent")).toContain(".env");
    expect(taskWorktreeCleanupBlockerMessage("ignoredContent")).toContain("will not delete them automatically");
    expect(taskWorktreeCleanupBlockerMessage("ignoredContent", true)).toContain("will be permanently deleted");
    expect(taskWorktreeCleanupBlockerMessage("trackedChanges", true)).not.toContain("manually first");
    expect(taskWorktreeCleanupBlockerMessage("submodulePresent", true)).toContain("permanently deleted");
    expect(taskWorktreeCleanupWarningMessage("upstreamNotConfigured")).toContain("does not track a remote branch");
    expect(taskWorktreeCleanupWarningMessage("upstreamNotConfigured")).toContain("informational only");
  });

  it("retires Sessions only when no hard or unknown cleanup blocker exists", () => {
    expect(taskDeleteSessionRetirementGate(cleanupPreview(["sessionAttached"]))).toMatchObject({ status: "allowed" });
    expect(taskDeleteSessionRetirementGate(cleanupPreview(["sessionAttached", "ignoredContent"]))).toMatchObject({
      status: "allowed",
      contentBlockers: ["ignoredContent"],
    });
    expect(taskDeleteSessionRetirementGate(cleanupPreview(["sessionAttached", "submodulePresent"]))).toMatchObject({
      status: "allowed",
      contentBlockers: ["submodulePresent"],
    });
    expect(taskDeleteSessionRetirementGate(cleanupPreview(["sessionAttached", "worktreeLock"]))).toMatchObject({ status: "blocked" });
    expect(taskDeleteSessionRetirementGate(cleanupPreview(["sessionAttached"], "unknown"))).toMatchObject({ status: "blocked" });
  });

  it("offers combined deletion for acknowledged submodule content but not hard gates", () => {
    expect(taskDeletePreviewCanProceed({
      ...cleanupPreview(["submodulePresent"]),
      destructive_cleanup: { status: "available", eligible_blockers: ["submodulePresent"] },
      presence: { ...cleanupPreview([]).presence!, attached_sessions: [], total_count: 0, agent_count: 0 },
    })).toBe(true);
    expect(taskDeletePreviewCanProceed(cleanupPreview(["worktreeLock"]))).toBe(false);
    expect(taskDeletePreviewCanProceed({
      ...cleanupPreview(["pathRegistrationInconsistent"]),
      stale_resolution: { forget_status: "available", disposal_status: "unavailable", blockers: [] },
    })).toBe(true);
  });

  it("bounds Session retirement to eight strictly progressing batches", () => {
    const preview = cleanupPreview(["sessionAttached"]);
    expect(taskDeleteSessionBatch(preview, new Set(), 0)).toEqual({ status: "ready", sessionIds: ["session-1"] });
    expect(taskDeleteSessionBatch(preview, new Set(["session-1"]), 1)).toEqual({ status: "blocked", reason: "noProgress" });
    expect(taskDeleteSessionBatch(preview, new Set(), TASK_DELETE_SESSION_MAX_ROUNDS)).toEqual({ status: "blocked", reason: "roundLimit" });
  });

  it("treats terminate notFound as satisfied only with complete refreshed absence", () => {
    const preview = cleanupPreview(["sessionAttached"]);
    expect(taskDeleteTerminationNotFoundSatisfied(preview, "session-1")).toBe(false);
    expect(taskDeleteTerminationNotFoundSatisfied({ ...preview, presence: null }, "session-1")).toBe(false);
    expect(taskDeleteTerminationNotFoundSatisfied({
      ...preview,
      presence: { ...preview.presence!, attached_sessions: [], truncated: true },
    }, "session-1")).toBe(false);
    expect(taskDeleteTerminationNotFoundSatisfied({
      ...preview,
      presence: { ...preview.presence!, attached_sessions: [], total_count: 0 },
    }, "session-1")).toBe(true);
  });
});
