import type { TaskCreateParams } from "@termloop/contract/current";

export function interactiveTaskCreateParams(
  projectId: string,
  title: string,
  brief: string | null,
): TaskCreateParams {
  // The desktop create flows resolve the Project default into visible choices,
  // then provision/launch those exact choices themselves. Suppress daemon-side
  // inheritance here or both paths race to create the same worktree.
  return {
    projectId,
    title,
    brief,
    worktreeIntent: "none",
    agentId: null,
    model: null,
    reasoning: null,
    kickoffMessage: null,
  };
}
