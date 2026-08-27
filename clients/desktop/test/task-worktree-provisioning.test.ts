import { describe, expect, it } from "vitest";
import {
  dismissibleFailedProvisioningOperationId,
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
