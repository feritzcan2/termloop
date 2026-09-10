import { presentedAgentStatus } from "../../presentation/session-presentation";
import type { ConnectionOverviewSnapshot } from "./overview-resilience";

export function acknowledgeSnapshotInterruption(
  snapshot: ConnectionOverviewSnapshot,
  sessionId: string,
  observedAtEpochMs: number,
): ConnectionOverviewSnapshot {
  const status = snapshot.overview?.agentStatuses.find((candidate) => candidate.sessionId === sessionId);
  if (status?.status !== "interrupted" || status.observedAtEpochMs !== observedAtEpochMs
    || snapshot.acknowledgedInterruptedSessionObservations.get(sessionId) === observedAtEpochMs) return snapshot;
  return {
    ...snapshot,
    acknowledgedInterruptedSessionObservations: new Map(snapshot.acknowledgedInterruptedSessionObservations)
      .set(sessionId, observedAtEpochMs),
  };
}

/// Every route, including workflow cards and Home's per-Mac summaries, sees the
/// same acknowledgement. Refresh/review detection still consumes the raw DTOs.
export function presentedOverviewSnapshot(snapshot: ConnectionOverviewSnapshot): ConnectionOverviewSnapshot {
  if (!snapshot.overview || snapshot.acknowledgedInterruptedSessionObservations.size === 0) return snapshot;
  return {
    ...snapshot,
    overview: {
      ...snapshot.overview,
      agentStatuses: snapshot.overview.agentStatuses.map((status) =>
        presentedAgentStatus(status, snapshot.acknowledgedInterruptedSessionObservations)),
    },
  };
}
