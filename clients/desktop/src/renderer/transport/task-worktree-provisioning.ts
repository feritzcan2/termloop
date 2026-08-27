import type { TaskWorktreeProvisioningDto } from "@termloop/contract/current";
import type { TaskProvisionWorktreeDesktopResult } from "./desktop-api.js";

export function dismissibleFailedProvisioningOperationId(
  provisioning: TaskWorktreeProvisioningDto | undefined,
): string | undefined {
  return provisioning?.status === "failed"
    && provisioning.failure?.kind !== "recoveryAttention"
    ? provisioning.operation_id
    : undefined;
}

export function taskProvisionWorktreeFailureMessage(
  result: TaskProvisionWorktreeDesktopResult,
): string | undefined {
  if (result.ok) {
    return result.result.provisioning?.status === "running"
      ? `Worktree creation operation ${result.result.provisioning.operation_id} is still running.`
      : undefined;
  }
  switch (result.details?.kind) {
    case "branchHeldByTask":
      return `Branch is already held by Task ${result.details.taskId}.`;
    case "taskBranchAlreadyBound":
      return `Task ${result.details.taskId} already has a different branch.`;
    case "worktreePathHeldByTask":
      return `Worktree path is already held by Task ${result.details.taskId}.`;
    case "provisioningAlreadyInProgress":
      return `Provisioning operation ${result.details.operationId} is already in progress.`;
    case "operationIdReused":
      return `Operation ${result.details.operationId} was already used for different inputs.`;
    case "branchCheckedOutElsewhere":
      return `Branch is already checked out at ${result.details.worktreePath}.`;
    case "worktreeRecoveryAttention":
      return `Provisioning operation ${result.details.operationId} needs recovery attention.`;
    default:
      return result.message;
  }
}
