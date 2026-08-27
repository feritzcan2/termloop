import type { AgentStatus } from "../model.js";

export function newlyReviewReadySessions(
  previous: ReadonlyMap<string, string>,
  current: readonly AgentStatus[],
): string[] {
  return current
    .filter((status) =>
      status.status === "idle"
      && (status.source === "hook" || status.source === "appServer")
      && previous.get(status.sessionId) === "working"
    )
    .map((status) => status.sessionId);
}
