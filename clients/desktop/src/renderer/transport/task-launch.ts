import type { ProtocolErrorDetails } from "@termloop/contract/current";

export type TypedTaskFailure = {
  message: string;
  details: ProtocolErrorDetails | undefined;
};

export function taskLaunchFailureMessage(failure: TypedTaskFailure): string {
  if (failure.details?.kind === "worktreeRequired") {
    return "Create a worktree before launching this Task.";
  }
  if (failure.details?.kind === "worktreeUnavailable") {
    return `Task worktree unavailable: ${failure.details.reason}.`;
  }
  return failure.message;
}
