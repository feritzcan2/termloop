import { describe, expect, it, vi } from "vitest";
import type { TaskProvisionWorktreeParams, TaskWorktreeProvisioningDto } from "@termloop/contract/current";
import type { DesktopApi, TaskProvisionWorktreeDesktopResult } from "../src/renderer/transport/desktop-api.js";
import {
  dismissibleFailedProvisioningOperationId,
  provisionTaskWorktree,
  taskProvisionWorktreeFailureMessage,
} from "../src/renderer/transport/task-worktree-provisioning.js";

describe("Task worktree provisioning diagnostics", () => {
  it("uses typed checked-out and recovery details without parsing server text", () => {
    expect(taskProvisionWorktreeFailureMessage({
      ok: false,
      code: "conflict",
      details: { kind: "branchCheckedOutElsewhere", worktreePath: "/tmp/other" },
      message: "opaque",
    })).toBe("Branch is already checked out at /tmp/other.");
    expect(taskProvisionWorktreeFailureMessage({
      ok: false,
      code: "conflict",
      details: { kind: "worktreeRecoveryAttention", operationId: "operation-1" },
      message: "opaque",
    })).toBe("Provisioning operation operation-1 needs recovery attention.");
  });

  it("keeps a coalesced running operation visible instead of reporting completion", () => {
    expect(taskProvisionWorktreeFailureMessage({
      ok: true,
      result: {
        task: {} as never,
        provisioning: {
          operation_id: "operation-running",
          status: "running",
          failure: null,
        },
      },
    })).toBe("Worktree creation operation operation-running is still running.");
  });

  it("replaces only dismissible failed journals before a changed retry", () => {
    expect(dismissibleFailedProvisioningOperationId({
      operation_id: "operation-path",
      status: "failed",
      failure: { kind: "pathConflict" },
    })).toBe("operation-path");
    expect(dismissibleFailedProvisioningOperationId({
      operation_id: "operation-recovery",
      status: "failed",
      failure: { kind: "recoveryAttention" },
    })).toBeUndefined();
    expect(dismissibleFailedProvisioningOperationId({
      operation_id: "operation-running",
      status: "running",
      failure: null,
    })).toBeUndefined();
  });
});

describe("Task worktree retry orchestration", () => {
  const params: TaskProvisionWorktreeParams = {
    taskId: "task-1",
    operationId: "new-operation",
    repositoryPath: "/repo",
    destinationPath: "/task-worktree",
    branchName: "feature/task",
    branchMode: "create",
    baseRef: "refs/remotes/origin/main",
  };
  const failed: TaskWorktreeProvisioningDto = {
    operation_id: "old-operation",
    status: "failed",
    failure: { kind: "timeout" },
  };
  const completed: TaskProvisionWorktreeDesktopResult = {
    ok: true,
    result: { task: {} as never, provisioning: null },
  };
  const conflict: TaskProvisionWorktreeDesktopResult = {
    ok: false,
    code: "conflict",
    message: "conflicting inputs",
    details: { kind: "provisioningAlreadyInProgress", operationId: "old-operation" },
  };
  function api() {
    return {
      taskProvisionWorktree: vi.fn<DesktopApi["taskProvisionWorktree"]>(),
      taskDismissWorktreeProvisioning: vi.fn<DesktopApi["taskDismissWorktreeProvisioning"]>(),
    };
  }

  it("resumes a verification failure without trying to dismiss its existing worktree", async () => {
    const transport = api();
    transport.taskProvisionWorktree.mockResolvedValue(completed);
    expect(await provisionTaskWorktree(transport, params, failed)).toEqual(completed);
    expect(transport.taskProvisionWorktree).toHaveBeenCalledExactlyOnceWith(params);
    expect(transport.taskDismissWorktreeProvisioning).not.toHaveBeenCalled();
  });

  it("replaces a changed failed attempt only after Core identifies the conflicting journal", async () => {
    const transport = api();
    const calls: string[] = [];
    transport.taskProvisionWorktree.mockImplementation(async () => {
      calls.push("provision");
      return calls.length === 1 ? conflict : completed;
    });
    transport.taskDismissWorktreeProvisioning.mockImplementation(async () => {
      calls.push("dismiss");
      return {} as never;
    });
    expect(await provisionTaskWorktree(transport, params, failed)).toEqual(completed);
    expect(calls).toEqual(["provision", "dismiss", "provision"]);
    expect(transport.taskDismissWorktreeProvisioning).toHaveBeenCalledExactlyOnceWith("task-1", "old-operation");
  });

  it("stops if a concurrent retry or existing content prevents dismissal", async () => {
    const transport = api();
    transport.taskProvisionWorktree.mockResolvedValue(conflict);
    transport.taskDismissWorktreeProvisioning.mockRejectedValue(new Error("recovery attention"));
    await expect(provisionTaskWorktree(transport, params, failed)).rejects.toThrow("recovery attention");
    expect(transport.taskProvisionWorktree).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    { ...failed, operation_id: "stale-operation" },
    { ...failed, status: "running" as const, failure: null },
    { ...failed, failure: { kind: "recoveryAttention" as const } },
  ])("preserves an unproven, running, or recovery journal: %j", async (provisioning) => {
    const transport = api();
    transport.taskProvisionWorktree.mockResolvedValue(conflict);
    expect(await provisionTaskWorktree(transport, params, provisioning)).toEqual(conflict);
    expect(transport.taskProvisionWorktree).toHaveBeenCalledTimes(1);
    expect(transport.taskDismissWorktreeProvisioning).not.toHaveBeenCalled();
  });

  it("does not discard a newly reported failure or an unrelated operation-ID conflict", async () => {
    const transport = api();
    for (const details of [
      { kind: "operationIdReused" as const, operationId: "new-operation" },
      { kind: "worktreeRecoveryAttention" as const, operationId: "old-operation" },
    ]) {
      const result = { ...conflict, details };
      transport.taskProvisionWorktree.mockResolvedValue(result);
      expect(await provisionTaskWorktree(transport, params, failed)).toEqual(result);
    }
    expect(transport.taskProvisionWorktree).toHaveBeenCalledTimes(2);
    expect(transport.taskDismissWorktreeProvisioning).not.toHaveBeenCalled();
  });

  it("returns a coalesced running operation without clearing it", async () => {
    const transport = api();
    const running: TaskProvisionWorktreeDesktopResult = {
      ok: true,
      result: { task: {} as never, provisioning: { ...failed, status: "running", failure: null } },
    };
    transport.taskProvisionWorktree.mockResolvedValue(running);
    expect(await provisionTaskWorktree(transport, params, failed)).toEqual(running);
    expect(transport.taskDismissWorktreeProvisioning).not.toHaveBeenCalled();
  });
});
