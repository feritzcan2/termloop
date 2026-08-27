import type { TaskCleanupWorktreeOutcome, TaskCleanupWorktreeParams, TaskDiscardStaleWorktreeParams, TaskForgetStaleWorktreeParams } from "@termloop/contract/current";
import type { TaskControlDesktopResult } from "../transport/desktop-api.js";
import {
  isLiveSession,
  taskDeleteSessionBatch,
  taskDeleteSessionRetirementGate,
  taskDeleteTerminationNotFoundSatisfied,
  taskWorktreeCleanupOperationId,
  type Session,
  type Task,
  type TaskDeleteWorktreeResult,
  type TaskDeleteWorktreeReview,
} from "../model.js";

type Preview = TaskDeleteWorktreeReview["preview"];
const DELETE_SAFETY_FAILURE = "TermLoop could not safely delete this worktree.";

export type TaskDeleteOrchestration = {
  taskId: string;
  review: TaskDeleteWorktreeReview | undefined;
  currentTask(): Task | undefined;
  currentSession(sessionId: string): Session | undefined;
  inspect(): Promise<Preview>;
  refresh(): Promise<void>;
  terminate(sessionId: string): Promise<TaskControlDesktopResult<unknown>>;
  close(sessionId: string): Promise<unknown>;
  cleanup(params: TaskCleanupWorktreeParams): Promise<{ outcome: TaskCleanupWorktreeOutcome }>;
  forgetStale(params: TaskForgetStaleWorktreeParams): Promise<TaskControlDesktopResult<Task>>;
  discardStale(params: TaskDiscardStaleWorktreeParams): Promise<TaskControlDesktopResult<Task>>;
  deleteTask(): Promise<unknown>;
  completion?: "delete" | "close";
  freshId(): string;
  errorMessage(error: unknown): string;
};

function previewTargetsSameWorktree(reviewed: Preview, current: Preview): boolean {
  return reviewed.task_id === current.task_id
    && reviewed.managed_worktree_operation_id === current.managed_worktree_operation_id
    && reviewed.worktree_generation === current.worktree_generation
    && reviewed.target_path === current.target_path;
}

function cleanupIntent(current: Preview): {
  mode: "safe" | "discardCheckoutContent";
  acknowledgedContentBlockers: TaskCleanupWorktreeParams["acknowledgedContentBlockers"];
} | undefined {
  if (current.decision === "allowed" && current.blockers.length === 0) {
    return { mode: "safe", acknowledgedContentBlockers: [] };
  }
  if (current.destructive_cleanup.status === "available") {
    return {
      mode: "discardCheckoutContent",
      acknowledgedContentBlockers: [...current.destructive_cleanup.eligible_blockers],
    };
  }
  return undefined;
}

export async function orchestrateTaskDelete(input: TaskDeleteOrchestration): Promise<TaskDeleteWorktreeResult> {
  const closesTask = input.completion === "close";
  const completedResult = (): TaskDeleteWorktreeResult => closesTask
    ? { status: "completed", message: "Worktree removed and Task closed. Parked Agents will restore when the Task is reopened." }
    : retainedDescriptors > 0
      ? { status: "completed", message: `${retainedDescriptors} stopped Session descriptor${retainedDescriptors === 1 ? " was" : "s were"} retained.` }
      : { status: "completed" };
  const reviewRequired = (preview: Preview, message: string): TaskDeleteWorktreeResult => ({
    status: "reviewRequired",
    preview,
    message,
  });
  let worktreeRemoved = false;
  let bindingForgotten = false;
  let retainedDescriptors = 0;
  try {
    const task = input.currentTask();
    if (!task) return { status: "completed" };
    if (!task.worktree) {
      await input.deleteTask();
      await input.refresh();
      return { status: "completed" };
    }
    if (!input.review) return { status: "failed", message: "Inspect the worktree before deleting it." };

    let preview = await input.inspect();
    if (!previewTargetsSameWorktree(input.review.preview, preview)) {
      return reviewRequired(preview, "The worktree changed. Review the fresh inspection before continuing.");
    }

    if (input.review.kind === "forgetStaleBinding") {
      if (closesTask) {
        return reviewRequired(preview, "Choose permanent folder deletion to remove the worktree and close this Task.");
      }
      if (preview.stale_resolution.forget_status !== "available"
        || !preview.target_path) {
        return reviewRequired(preview, "The stale binding can no longer be forgotten. Review the fresh inspection.");
      }
      const outcome = await input.forgetStale({
        operationId: input.freshId(),
        taskId: input.taskId,
        expectedManagedWorktreeOperationId: preview.managed_worktree_operation_id,
        expectedWorktreeGeneration: preview.worktree_generation,
        targetPath: preview.target_path,
      });
      if (!outcome.ok) return { status: "failed", message: outcome.message };
      bindingForgotten = true;
      await input.deleteTask();
      await input.refresh();
      return { status: "completed", message: "The stale Task binding was forgotten. The folder and its Sessions were left untouched." };
    }

    if (input.review.kind === "discardStaleDirectory") {
      let stoppedAny = false;
      const retiredSessionIds = new Set<string>();
      let rounds = 0;
      while (preview.stale_resolution.disposal_status === "sessionRetirementRequired") {
        const presence = preview.presence;
        const sessionIds = presence?.attached_sessions.map((session) => session.session_id) ?? [];
        if (!presence || presence.truncated || sessionIds.length === 0 || sessionIds.length > 64 || rounds >= 8) {
          return {
            status: "failed",
            message: stoppedAny
              ? "Some Sessions were already stopped, but stale folder disposal could not continue safely."
              : "Attached Sessions could not be retired safely; no Session was stopped.",
          };
        }
        const next = sessionIds.filter((sessionId) => !retiredSessionIds.has(sessionId));
        if (next.length === 0) {
          return { status: "failed", message: "Session retirement made no progress; the folder was not removed." };
        }
        for (const sessionId of next) {
          const session = input.currentSession(sessionId);
          if (session && isLiveSession(session)) {
            const outcome = await input.terminate(sessionId);
            if (!outcome.ok) {
              if (outcome.code !== "notFound") return { status: "failed", message: outcome.message };
              const refreshed = await input.inspect();
              if (!taskDeleteTerminationNotFoundSatisfied(refreshed, sessionId)) {
                return { status: "failed", message: outcome.message };
              }
            }
            stoppedAny = true;
          }
          retiredSessionIds.add(sessionId);
        }
        await input.refresh();
        for (const sessionId of next) {
          const session = input.currentSession(sessionId);
          if (!session) continue;
          if (!session.closable) {
            if (isLiveSession(session)) retiredSessionIds.delete(sessionId);
            else retainedDescriptors += 1;
            continue;
          }
          try {
            await input.close(sessionId);
          } catch {
            await input.refresh();
            const refreshed = input.currentSession(sessionId);
            if (refreshed && isLiveSession(refreshed)) retiredSessionIds.delete(sessionId);
            else if (refreshed) retainedDescriptors += 1;
          }
        }
        await input.refresh();
        rounds += 1;
        preview = await input.inspect();
        if (!previewTargetsSameWorktree(input.review.preview, preview)) {
          return reviewRequired(preview, "Sessions were stopped, but the worktree changed. Review the fresh inspection.");
        }
        if (preview.stale_resolution.disposal_status === "unavailable") {
          return {
            status: "failed",
            message: "Sessions were stopped, but fresh safety facts now block unverified-folder deletion.",
          };
        }
      }
      if (preview.stale_resolution.disposal_status !== "available"
        || !preview.target_path) {
        return { status: "failed", message: DELETE_SAFETY_FAILURE };
      }
      const currentResolution = input.currentTask()?.worktree_stale_resolution;
      const retryOperationId = currentResolution?.mode === "discardDirectory"
        && (currentResolution.stage === "removalPrepared"
          || currentResolution.stage === "removalInvoked")
        && currentResolution.status === "failed"
        && currentResolution.failure?.kind === "recoveryAttention"
        && currentResolution.managed_worktree_operation_id === preview.managed_worktree_operation_id
        && currentResolution.worktree_generation === preview.worktree_generation
        && currentResolution.target_path === preview.target_path
        ? currentResolution.operation_id
        : undefined;
      const outcome = await input.discardStale({
        operationId: retryOperationId ?? input.freshId(),
        taskId: input.taskId,
        expectedManagedWorktreeOperationId: preview.managed_worktree_operation_id,
        expectedWorktreeGeneration: preview.worktree_generation,
        targetPath: preview.target_path,
        acknowledgeUnverifiedDirectoryDeletion: true,
      });
      if (!outcome.ok) return { status: "failed", message: outcome.message };
      worktreeRemoved = true;
      await input.deleteTask();
      await input.refresh();
      return completedResult();
    }

    if (input.review.kind !== "cleanup") {
      return { status: "failed", message: "The stale-resolution intent is invalid." };
    }

    const retiredSessionIds = new Set<string>();
    let completedRounds = 0;
    while (true) {
      const batch = taskDeleteSessionBatch(preview, retiredSessionIds, completedRounds);
      if (batch.status === "complete") break;
      if (batch.status === "blocked") {
        return {
          status: "failed",
          message: retiredSessionIds.size > 0
            ? "Some Sessions were already stopped, but the remaining attached Sessions could not be retired safely."
            : "Attached Sessions could not be retired safely; no Session was stopped.",
        };
      }

      for (const sessionId of batch.sessionIds) {
        const session = input.currentSession(sessionId);
        if (session && isLiveSession(session)) {
          const outcome = await input.terminate(sessionId);
          if (!outcome.ok) {
            if (outcome.code !== "notFound") return { status: "failed", message: outcome.message };
            const refreshed = await input.inspect();
            if (!taskDeleteTerminationNotFoundSatisfied(refreshed, sessionId)) {
              return { status: "failed", message: outcome.message };
            }
          }
        }
        retiredSessionIds.add(sessionId);
      }

      await input.refresh();
      for (const sessionId of batch.sessionIds) {
        const session = input.currentSession(sessionId);
        if (!session) continue;
        if (!session.closable) {
          if (isLiveSession(session)) retiredSessionIds.delete(sessionId);
          else retainedDescriptors += 1;
          continue;
        }
        try {
          await input.close(sessionId);
        } catch {
          await input.refresh();
          const refreshed = input.currentSession(sessionId);
          if (refreshed && isLiveSession(refreshed)) retiredSessionIds.delete(sessionId);
          else if (refreshed) retainedDescriptors += 1;
        }
      }
      await input.refresh();
      completedRounds += 1;
      preview = await input.inspect();
      if (!previewTargetsSameWorktree(input.review.preview, preview)) {
        return reviewRequired(preview, "Sessions were stopped, but the worktree changed. Review the fresh inspection.");
      }
    }
    const intent = cleanupIntent(preview);
    if (!intent) {
      return { status: "failed", message: DELETE_SAFETY_FAILURE };
    }
    if (!preview.managed_worktree_operation_id) {
      return { status: "failed", message: "The managed worktree proof is unavailable." };
    }

    const currentTask = input.currentTask() ?? task;
    const cleanupParams: TaskCleanupWorktreeParams = {
      operationId: taskWorktreeCleanupOperationId(
        currentTask,
        intent.mode,
        intent.acknowledgedContentBlockers,
        input.freshId,
      ),
      taskId: input.taskId,
      expectedManagedWorktreeOperationId: preview.managed_worktree_operation_id,
      expectedWorktreeGeneration: preview.worktree_generation,
      cleanupMode: intent.mode,
      acknowledgedContentBlockers: intent.acknowledgedContentBlockers,
    };
    try {
      const cleanup = await input.cleanup(cleanupParams);
      if (cleanup.outcome === "running") {
        await input.refresh();
        return {
          status: "failed",
          message: `Worktree cleanup is still running. Wait for it to finish before ${closesTask ? "closing" : "deleting"} the Task.`,
        };
      }
    } catch (cleanupError) {
      await input.refresh();
      const recoveryPreview = await input.inspect();
      const disposalStatus = recoveryPreview.stale_resolution.disposal_status;
      if (previewTargetsSameWorktree(input.review.preview, recoveryPreview)
        && (disposalStatus === "available" || disposalStatus === "sessionRetirementRequired")) {
        return reviewRequired(
          recoveryPreview,
          "Cleanup left an unverified stale folder. Review it before choosing whether to keep or permanently delete it.",
        );
      }
      throw cleanupError;
    }
    worktreeRemoved = true;
    await input.deleteTask();
    await input.refresh();
    return completedResult();
  } catch (error) {
    try {
      await input.refresh();
    } catch {}
    if (!input.currentTask()) return { status: "completed" };
    const message = input.errorMessage(error);
    return {
      status: "failed",
      message: worktreeRemoved
        ? `The worktree was removed, but the Task could not be ${closesTask ? "closed" : "deleted"}: ${message}`
        : bindingForgotten
          ? `The stale binding was forgotten and the folder was kept, but the Task could not be deleted: ${message}`
          : message,
    };
  }
}
