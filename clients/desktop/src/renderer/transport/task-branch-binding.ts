import type { TaskBindBranchResult } from "./desktop-api.js";

export function taskBindBranchFailureMessage(result: TaskBindBranchResult): string | undefined {
  if (result.ok) return undefined;
  if (result.details?.kind === "branchHeldByTask") {
    return `Branch is already held by Task ${result.details.taskId}.`;
  }
  if (result.details?.kind === "taskBranchAlreadyBound") {
    return `Task ${result.details.taskId} already has a different branch.`;
  }
  return result.message;
}
