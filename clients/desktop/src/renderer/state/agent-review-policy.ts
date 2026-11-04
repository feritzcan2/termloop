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
      && !attentionAcknowledgedByDaemon(status)
    )
    .map((status) => status.sessionId);
}

/// The daemon remembers which exact status observation a user has already
/// seen from any attached client. A newer observation carries a later
/// timestamp, so it surfaces again until someone looks at it in turn.
export function attentionAcknowledgedByDaemon(status: AgentStatus): boolean {
  const acknowledgedAt = status.attentionAcknowledgedAtEpochMs;
  return acknowledgedAt !== undefined && acknowledgedAt !== null && acknowledgedAt >= status.observedAtEpochMs;
}

export type AgentAttentionPresentation = {
  readonly reviewReadySessionIds: ReadonlySet<string>;
  readonly acknowledgedInterruptedSessionObservations: ReadonlyMap<string, number>;
};

export type AgentAttentionAcknowledgement = {
  readonly status: AgentStatus;
  readonly observedAtEpochMs: number;
};

/// Attention this client just dismissed locally that the daemon does not yet
/// know about. Sending it lets every other client attached to the same daemon
/// drop the same "Needs review" or "Interrupted" state. A review flag that
/// disappeared because the Agent started working again is not a dismissal.
export function locallyAcknowledgedAttention(
  previous: AgentAttentionPresentation,
  next: AgentAttentionPresentation,
  statuses: readonly AgentStatus[],
): AgentAttentionAcknowledgement[] {
  if (
    previous.reviewReadySessionIds === next.reviewReadySessionIds
    && previous.acknowledgedInterruptedSessionObservations === next.acknowledgedInterruptedSessionObservations
  ) return [];
  const statusesById = new Map(statuses.map((status) => [status.sessionId, status]));
  const acknowledgements: AgentAttentionAcknowledgement[] = [];
  for (const sessionId of previous.reviewReadySessionIds) {
    if (next.reviewReadySessionIds.has(sessionId)) continue;
    const status = statusesById.get(sessionId);
    if (status?.status === "idle" && !attentionAcknowledgedByDaemon(status)) {
      acknowledgements.push({ status, observedAtEpochMs: status.observedAtEpochMs });
    }
  }
  for (const [sessionId, observedAtEpochMs] of next.acknowledgedInterruptedSessionObservations) {
    if (previous.acknowledgedInterruptedSessionObservations.get(sessionId) === observedAtEpochMs) continue;
    const status = statusesById.get(sessionId);
    if (
      status?.status === "interrupted"
      && status.observedAtEpochMs === observedAtEpochMs
      && !attentionAcknowledgedByDaemon(status)
    ) {
      acknowledgements.push({ status, observedAtEpochMs });
    }
  }
  return acknowledgements;
}
