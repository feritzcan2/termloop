import type { TaskProvisionWorktreeParams, TaskWorktreeProvisioningDto } from "@termloop/contract/current";
import type { DesktopApi, TaskProvisionWorktreeDesktopResult } from "./desktop-api.js";

export async function provisionTaskWorktree(
  api: Pick<DesktopApi, "taskProvisionWorktree" | "taskDismissWorktreeProvisioning">,
  params: TaskProvisionWorktreeParams,
  provisioning: TaskWorktreeProvisioningDto | undefined,
): Promise<TaskProvisionWorktreeDesktopResult> {
  // Same-spec retries must keep the journal: a worktree may already exist and
  // only need verification. Let Core distinguish a changed request first.
  const result = await api.taskProvisionWorktree(params);
  const failedOperationId = dismissibleFailedProvisioningOperationId(provisioning);
  if (!result.ok
    && failedOperationId
    && result.details?.kind === "provisioningAlreadyInProgress"
    && result.details.operationId === failedOperationId) {
    await api.taskDismissWorktreeProvisioning(params.taskId, failedOperationId);
    return api.taskProvisionWorktree(params);
  }
  return result;
}

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
