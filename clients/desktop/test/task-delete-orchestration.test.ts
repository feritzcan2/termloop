import { describe, expect, it } from "vitest";
import type { TaskWorktreeCleanupBlocker, TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import { orchestrateTaskDelete, type TaskDeleteOrchestration } from "../src/renderer/composition/task-delete-orchestration.js";
import type { Session, Task, TaskDeleteWorktreeReview } from "../src/renderer/model.js";

function task(): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    title: "Delete me",
    brief: null,
    jira_url: null,
    archived_at_epoch_ms: null,
    status: "open",
    branch: { repository_root: "/repo", name: "feature/delete" },
    worktree: { path: "/repo-worktree" },
    worktree_generation: 2,
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    project_id: "project-1",
    name: null,
    kind: "Terminal",
    lifecycle_state: "running",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: false,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    process: {
      program: "/bin/zsh",
      args: [],
      cwd: "/repo-worktree",
      agent_id: null,
      template_ref: null,
      template_version: null,
    },
    ...overrides,
  };
}

function preview(
  blockers: TaskWorktreeCleanupBlocker[],
  decision: "allowed" | "refused" | "unknown" = blockers.length ? "refused" : "allowed",
): TaskWorktreeCleanupPreviewDto {
  const attached = blockers.includes("sessionAttached");
  const content = blockers.filter((blocker) => ["trackedChanges", "stagedChanges", "untrackedContent", "ignoredContent", "submodulePresent"].includes(blocker));
  return {
    task_id: "task-1",
    managed_worktree_operation_id: "managed-1",
    worktree_generation: 2,
    target_path: "/repo-worktree",
    decision,
    blockers,
    warnings: ["upstreamNotConfigured"],
    health: null,
    presence: {
      observation_sequence: 1,
      observed_at_epoch_ms: 1,
      attached_sessions: attached ? [{ session_id: "session-1", kind: "Terminal" }] : [],
      total_count: attached ? 1 : 0,
      terminal_count: attached ? 1 : 0,
      agent_count: 0,
      truncated: false,
    },
    destructive_cleanup: content.length && !attached
      ? { status: "available", eligible_blockers: content }
      : { status: "unavailable", eligible_blockers: [] },
    stale_resolution: { forget_status: "unavailable", disposal_status: "unavailable", blockers: [] },
  };
}

function stalePreview(
  disposalStatus: "unavailable" | "sessionRetirementRequired" | "available" = "available",
  decision: "refused" | "unknown" = "refused",
): TaskWorktreeCleanupPreviewDto {
  const attached = disposalStatus === "sessionRetirementRequired";
  return {
    ...preview(attached ? ["pathRegistrationInconsistent", "orphanedManagedDirectory", "sessionAttached"] : ["pathRegistrationInconsistent", "orphanedManagedDirectory"], decision),
    stale_resolution: {
      forget_status: decision === "refused" ? "available" : "unavailable",
      disposal_status: disposalStatus,
      blockers: disposalStatus === "unavailable" ? ["observationFailed"] : attached ? ["sessionAttached"] : [],
    },
  };
}

function review(value: TaskWorktreeCleanupPreviewDto): TaskDeleteWorktreeReview {
  return { preview: value, kind: "cleanup" };
}

function harness(initialPreview: TaskWorktreeCleanupPreviewDto) {
  let currentTask: Task | undefined = task();
  let currentSession: Session | undefined = initialPreview.blockers.includes("sessionAttached") ? session() : undefined;
  let currentPreview = initialPreview;
  const calls = { terminate: 0, close: 0, cleanup: 0, forget: 0, discard: 0, delete: 0 };
  const input: TaskDeleteOrchestration = {
    taskId: "task-1",
    review: review(initialPreview),
    currentTask: () => currentTask,
    currentSession: () => currentSession,
    inspect: async () => currentPreview,
    refresh: async () => {},
    terminate: async () => {
      calls.terminate += 1;
      currentSession = session({ lifecycle_state: "exited", closable: true });
      currentPreview = preview(currentPreview.blockers.filter((blocker) => blocker !== "sessionAttached"));
      return { ok: true, result: {} };
    },
    close: async () => { calls.close += 1; currentSession = undefined; },
    cleanup: async () => {
      calls.cleanup += 1;
      currentTask = { ...currentTask!, worktree: null };
      return { outcome: "removed" };
    },
    forgetStale: async () => {
      calls.forget += 1;
      currentTask = { ...currentTask!, worktree: null };
      return { ok: true, result: currentTask };
    },
    discardStale: async () => {
      calls.discard += 1;
      currentTask = { ...currentTask!, worktree: null };
      return { ok: true, result: currentTask };
    },
    deleteTask: async () => { calls.delete += 1; currentTask = undefined; },
    freshId: () => "cleanup-1",
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
  };
  return { input, calls, setTask: (value: Task | undefined) => { currentTask = value; }, setSession: (value: Session | undefined) => { currentSession = value; }, setPreview: (value: TaskWorktreeCleanupPreviewDto) => { currentPreview = value; } };
}

describe("Task delete orchestration", () => {
  it("continues combined deletion when an alternate checkout has no core identity blockers", async () => {
    const initial = preview(["sessionAttached"]);
    const { input, calls } = harness(initial);
    expect(await orchestrateTaskDelete(input)).toMatchObject({ status: "completed" });
    expect(calls).toEqual({ terminate: 1, close: 1, cleanup: 1, forget: 0, discard: 0, delete: 1 });
  });

  it.each([
    preview(["sessionAttached", "worktreeLock"]),
    preview(["sessionAttached"], "unknown"),
  ])("performs zero mutation for a hard or unknown retirement gate", async (blockedPreview) => {
    const { input, calls } = harness(blockedPreview);
    const result = await orchestrateTaskDelete(input);
    expect(result.status).toBe("failed");
    expect(calls).toEqual({ terminate: 0, close: 0, cleanup: 0, forget: 0, discard: 0, delete: 0 });
  });

  it("retires Sessions and deletes fresh checkout content without a second confirmation", async () => {
    const initial = preview(["sessionAttached", "ignoredContent"]);
    const { input, calls } = harness(initial);
    const result = await orchestrateTaskDelete(input);
    expect(result.status).toBe("completed");
    expect(calls).toEqual({ terminate: 1, close: 1, cleanup: 1, forget: 0, discard: 0, delete: 1 });
  });

  it("deletes a managed worktree with an acknowledged initialized submodule", async () => {
    const initial = preview(["ignoredContent", "submodulePresent"]);
    const { input, calls } = harness(initial);
    const result = await orchestrateTaskDelete(input);
    expect(result.status).toBe("completed");
    expect(calls).toEqual({ terminate: 0, close: 0, cleanup: 1, forget: 0, discard: 0, delete: 1 });
  });

  it("stops on a typed hard terminate failure without closing or deleting", async () => {
    const initial = preview(["sessionAttached"]);
    const { input, calls } = harness(initial);
    input.terminate = async () => {
      calls.terminate += 1;
      return { ok: false, code: "operationFailed", details: undefined, message: "termination uncertain" };
    };
    const result = await orchestrateTaskDelete(input);
    expect(result).toEqual({ status: "failed", message: "termination uncertain" });
    expect(calls).toEqual({ terminate: 1, close: 0, cleanup: 0, forget: 0, discard: 0, delete: 0 });
  });

  it("accepts typed notFound only after complete refreshed absence", async () => {
    const initial = preview(["sessionAttached"]);
    const { input, calls, setPreview, setSession } = harness(initial);
    input.terminate = async () => {
      calls.terminate += 1;
      setSession(undefined);
      setPreview(preview([]));
      return { ok: false, code: "notFound", details: undefined, message: "gone" };
    };
    expect(await orchestrateTaskDelete(input)).toMatchObject({ status: "completed" });
    expect(calls).toEqual({ terminate: 1, close: 0, cleanup: 1, forget: 0, discard: 0, delete: 1 });
  });

  it("retains an unclosable stopped descriptor without blocking cleanup", async () => {
    const initial = preview(["sessionAttached"]);
    const { input, calls, setPreview, setSession } = harness(initial);
    input.terminate = async () => {
      calls.terminate += 1;
      setSession(session({ lifecycle_state: "resumeFailed", closable: false, resume_failure_reason: "runtimeOwnershipUncertain" }));
      setPreview(preview([]));
      return { ok: true, result: {} };
    };
    expect(await orchestrateTaskDelete(input)).toEqual({
      status: "completed",
      message: "1 stopped Session descriptor was retained.",
    });
    expect(calls).toEqual({ terminate: 1, close: 0, cleanup: 1, forget: 0, discard: 0, delete: 1 });
  });

  it("reports a generic close failure as a retained descriptor and continues only after fresh absence", async () => {
    const initial = preview(["sessionAttached"]);
    const { input, calls } = harness(initial);
    input.close = async () => { calls.close += 1; throw new Error("close refused"); };
    expect(await orchestrateTaskDelete(input)).toEqual({
      status: "completed",
      message: "1 stopped Session descriptor was retained.",
    });
    expect(calls).toEqual({ terminate: 1, close: 1, cleanup: 1, forget: 0, discard: 0, delete: 1 });
  });

  it("retries a close refusal only when the refreshed Session is still live and attached", async () => {
    const initial = preview(["sessionAttached"]);
    const { input, calls, setPreview, setSession } = harness(initial);
    input.close = async () => {
      calls.close += 1;
      if (calls.close === 1) {
        setSession(session({ lifecycle_state: "running", closable: false }));
        setPreview(initial);
        throw new Error("runtime still attached");
      }
      setSession(undefined);
    };
    expect(await orchestrateTaskDelete(input)).toMatchObject({ status: "completed" });
    expect(calls).toEqual({ terminate: 2, close: 2, cleanup: 1, forget: 0, discard: 0, delete: 1 });
  });

  it("does not ask again when warnings change after Session retirement", async () => {
    const initial = preview(["sessionAttached"]);
    const { input, calls, setPreview, setSession } = harness(initial);
    input.terminate = async () => {
      calls.terminate += 1;
      setSession(undefined);
      setPreview({ ...preview([]), warnings: ["upstreamAhead"] });
      return { ok: true, result: {} };
    };
    expect(await orchestrateTaskDelete(input)).toMatchObject({ status: "completed" });
    expect(calls).toEqual({ terminate: 1, close: 0, cleanup: 1, forget: 0, discard: 0, delete: 1 });
  });

  it("acknowledges fresh content categories discovered after Session retirement", async () => {
    const initial = preview(["sessionAttached"]);
    const { input, calls, setPreview, setSession } = harness(initial);
    input.terminate = async () => {
      calls.terminate += 1;
      setSession(undefined);
      setPreview(preview(["stagedChanges", "untrackedContent"]));
      return { ok: true, result: {} };
    };
    input.cleanup = async (params) => {
      calls.cleanup += 1;
      expect(params.cleanupMode).toBe("discardCheckoutContent");
      expect(params.acknowledgedContentBlockers).toEqual(["stagedChanges", "untrackedContent"]);
      return { outcome: "removed" };
    };
    expect(await orchestrateTaskDelete(input)).toMatchObject({ status: "completed" });
    expect(calls).toEqual({ terminate: 1, close: 0, cleanup: 1, forget: 0, discard: 0, delete: 1 });
  });

  it("requires a new click when the exact target identity changes after Session retirement", async () => {
    const initial = preview(["sessionAttached"]);
    const { input, calls, setPreview, setSession } = harness(initial);
    input.terminate = async () => {
      calls.terminate += 1;
      setSession(undefined);
      setPreview({ ...preview([]), worktree_generation: 3 });
      return { ok: true, result: {} };
    };
    expect(await orchestrateTaskDelete(input)).toMatchObject({ status: "reviewRequired" });
    expect(calls).toEqual({ terminate: 1, close: 0, cleanup: 0, forget: 0, discard: 0, delete: 0 });
  });

  it("keeps cleanup-success/delete-failure retry record-only", async () => {
    const initial = preview([]);
    const { input, calls, setTask } = harness(initial);
    input.deleteTask = async () => { calls.delete += 1; throw new Error("repairInProgress"); };
    const first = await orchestrateTaskDelete(input);
    expect(first).toEqual({
      status: "failed",
      message: "The worktree was removed, but the Task could not be deleted: repairInProgress",
    });
    input.review = undefined;
    input.deleteTask = async () => { calls.delete += 1; setTask(undefined); };
    expect(await orchestrateTaskDelete(input)).toMatchObject({ status: "completed" });
    expect(calls.cleanup).toBe(1);
    expect(calls.delete).toBe(2);
  });

  it("requires fresh review before switching from cleanup to unverified stale disposal", async () => {
    const initial = preview(["ignoredContent", "submodulePresent"]);
    initial.destructive_cleanup = {
      status: "available",
      eligible_blockers: ["ignoredContent", "submodulePresent"],
    };
    const stranded = stalePreview("available");
    const { input, calls, setPreview } = harness(initial);
    input.cleanup = async () => {
      calls.cleanup += 1;
      setPreview(stranded);
      throw new Error("repository is unavailable");
    };
    expect(await orchestrateTaskDelete(input)).toEqual({
      status: "reviewRequired",
      preview: stranded,
      message: "Cleanup left an unverified stale folder. Review it before choosing whether to keep or permanently delete it.",
    });
    expect(calls).toEqual({ terminate: 0, close: 0, cleanup: 1, forget: 0, discard: 0, delete: 0 });
  });

  it("does not delete the Task while a coalesced cleanup operation is still running", async () => {
    const initial = preview([]);
    const { input, calls } = harness(initial);
    input.cleanup = async () => {
      calls.cleanup += 1;
      return { outcome: "running" };
    };

    expect(await orchestrateTaskDelete(input)).toEqual({
      status: "failed",
      message: "Worktree cleanup is still running. Wait for it to finish before deleting the Task.",
    });
    expect(calls).toEqual({ terminate: 0, close: 0, cleanup: 1, forget: 0, discard: 0, delete: 0 });
  });

  it("forgets a proven stale binding without retiring Sessions or invoking filesystem cleanup", async () => {
    const initial = stalePreview("available");
    const { input, calls } = harness(initial);
    input.review = { preview: initial, kind: "forgetStaleBinding" };
    expect(await orchestrateTaskDelete(input)).toEqual({
      status: "completed",
      message: "The stale Task binding was forgotten. The folder and its Sessions were left untouched.",
    });
    expect(calls).toEqual({ terminate: 0, close: 0, cleanup: 0, forget: 1, discard: 0, delete: 1 });
  });

  it("reports that the folder was kept when Task deletion fails after forgetting the binding", async () => {
    const initial = stalePreview("available");
    const { input, calls } = harness(initial);
    input.review = { preview: initial, kind: "forgetStaleBinding" };
    input.deleteTask = async () => {
      calls.delete += 1;
      throw new Error("repairInProgress");
    };
    expect(await orchestrateTaskDelete(input)).toEqual({
      status: "failed",
      message: "The stale binding was forgotten and the folder was kept, but the Task could not be deleted: repairInProgress",
    });
    expect(calls).toEqual({ terminate: 0, close: 0, cleanup: 0, forget: 1, discard: 0, delete: 1 });
  });

  it.each([
    stalePreview("unavailable"),
    stalePreview("unavailable", "unknown"),
  ])("performs zero mutation when stale disposal is unavailable or unknown", async (blockedPreview) => {
    const { input, calls } = harness(blockedPreview);
    input.review = { preview: blockedPreview, kind: "discardStaleDirectory" };
    expect(await orchestrateTaskDelete(input)).toMatchObject({ status: "failed" });
    expect(calls).toEqual({ terminate: 0, close: 0, cleanup: 0, forget: 0, discard: 0, delete: 0 });
  });

  it("stops attached Sessions and continues stale disposal without a second confirmation", async () => {
    const initial = stalePreview("sessionRetirementRequired");
    const { input, calls, setPreview, setSession } = harness(initial);
    input.review = { preview: initial, kind: "discardStaleDirectory" };
    input.terminate = async () => {
      calls.terminate += 1;
      setSession(session({ lifecycle_state: "exited", closable: true }));
      setPreview(stalePreview("available"));
      return { ok: true, result: {} };
    };
    expect(await orchestrateTaskDelete(input)).toMatchObject({ status: "completed" });
    expect(calls).toEqual({ terminate: 1, close: 1, cleanup: 0, forget: 0, discard: 1, delete: 1 });
  });

  it("discards an acknowledged stale directory before deleting the Task", async () => {
    const initial = stalePreview("available");
    const { input, calls } = harness(initial);
    input.review = { preview: initial, kind: "discardStaleDirectory" };
    expect(await orchestrateTaskDelete(input)).toEqual({ status: "completed" });
    expect(calls).toEqual({ terminate: 0, close: 0, cleanup: 0, forget: 0, discard: 1, delete: 1 });
  });

  it("does not delete the Task when stale directory disposal fails", async () => {
    const initial = stalePreview("available");
    const { input, calls } = harness(initial);
    input.review = { preview: initial, kind: "discardStaleDirectory" };
    input.discardStale = async () => {
      calls.discard += 1;
      return { ok: false, code: "operationFailed", details: undefined, message: "facts changed" };
    };
    expect(await orchestrateTaskDelete(input)).toEqual({ status: "failed", message: "facts changed" });
    expect(calls).toEqual({ terminate: 0, close: 0, cleanup: 0, forget: 0, discard: 1, delete: 0 });
  });

  it("reuses the durable operation ID for an exact recovery-attention disposal retry", async () => {
    const initial = stalePreview("available");
    const { input, calls, setTask } = harness(initial);
    setTask({
      ...task(),
      worktree_stale_resolution: {
        operation_id: "stale-retry-1",
        managed_worktree_operation_id: "managed-1",
        worktree_generation: 2,
        target_path: "/repo-worktree",
        mode: "discardDirectory",
        stage: "removalPrepared",
        status: "failed",
        failure: { kind: "recoveryAttention", blockers: ["recoveryAttention"] },
      },
    });
    input.review = { preview: initial, kind: "discardStaleDirectory" };
    input.discardStale = async (params) => {
      calls.discard += 1;
      expect(params.operationId).toBe("stale-retry-1");
      return { ok: true, result: task() };
    };
    expect(await orchestrateTaskDelete(input)).toMatchObject({ status: "completed" });
    expect(calls.discard).toBe(1);
    expect(calls.delete).toBe(1);
  });
});
