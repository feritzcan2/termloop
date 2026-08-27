import type { AgentStatusDto } from "@termloop/contract/current";

/**
 * A structured agent that moves from working to idle while this client is
 * observing has completed a turn and is ready for the owner to review. An
 * initial idle snapshot is not enough evidence: treating it as a transition
 * makes every resting agent demand attention whenever the app cold-starts.
 * Opening the Session acknowledges it, and a new working turn clears it.
 */
export function newlyReviewReadySessions(
  previous: ReadonlyMap<string, string>,
  current: readonly AgentStatusDto[],
): readonly string[] {
  return current
    .filter((status) =>
      status.status === "idle"
      && (status.source === "hook" || status.source === "appServer")
      && previous.get(status.sessionId) === "working"
    )
    .map((status) => status.sessionId);
}

export function reconcileReviewReadySessions(
  existing: ReadonlySet<string>,
  previous: ReadonlyMap<string, string>,
  current: readonly AgentStatusDto[],
): ReadonlySet<string> {
  const idle = new Set(current
    .filter((status) => status.status === "idle")
    .map((status) => status.sessionId));
  const next = new Set([...existing].filter((sessionId) => idle.has(sessionId)));
  for (const sessionId of newlyReviewReadySessions(previous, current)) next.add(sessionId);
  return next;
}

export function statusMap(statuses: readonly AgentStatusDto[]): ReadonlyMap<string, string> {
  return new Map(statuses.map((status) => [status.sessionId, status.status]));
}
