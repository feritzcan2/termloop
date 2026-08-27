import type { AgentStatus } from "../model.js";

export function newlyAwaitingSessions(
  previous: ReadonlyMap<string, string>,
  current: readonly AgentStatus[],
): string[] {
  return current
    .filter((status) =>
      status.status === "awaitingInput"
      && (status.source === "hook" || status.source === "appServer")
      && previous.get(status.sessionId) !== "awaitingInput"
    )
    .map((status) => status.sessionId);
}
