import type { AgentStatus, AgentStatusDto, SessionDto } from "@termloop/contract/current";

export type AgentAttentionKind = "needsInput" | "needsReview";

/// One agent-attention alert still sitting in the iOS notification tray.
export interface PresentedAttentionNotification {
  readonly identifier: string;
  readonly deliveredAtEpochMs: number;
  readonly connectionId?: string;
  readonly sessionId: string;
  readonly attentionKind: AgentAttentionKind;
}

/// One Mac's latest authoritative read, as the overview store holds it.
export interface AttentionScope {
  readonly connectionId: string;
  readonly readAtEpochMs: number;
  readonly sessions: readonly Pick<SessionDto, "id" | "lifecycle_state" | "archived_at_epoch_ms">[];
  readonly agentStatuses: readonly Pick<AgentStatusDto, "sessionId" | "status">[];
}

/// Attention-push data is untrusted APNs input. Steward pushes carry their own
/// conversation semantics and are never reconciled against Agent status.
export function attentionNotificationOf(
  identifier: string,
  deliveredAtEpochMs: number,
  contentData: unknown,
  trigger: unknown,
): PresentedAttentionNotification | undefined {
  const data = attentionData(contentData) ?? (isRecord(trigger) ? attentionData(trigger.payload) : undefined);
  if (data === undefined || !Number.isFinite(deliveredAtEpochMs)) return undefined;
  return {
    identifier,
    deliveredAtEpochMs,
    ...(data.connectionId === undefined ? {} : { connectionId: data.connectionId }),
    sessionId: data.sessionId,
    attentionKind: data.attentionKind,
  };
}

/// Returns tray alerts whose attention was already handled elsewhere, for example
/// by answering the agent on the Mac. Only a read taken after the push arrived is
/// evidence; an older or missing read keeps the alert, so a slow Mac never erases
/// a request the user has not seen.
export function staleAttentionNotifications(
  presented: readonly PresentedAttentionNotification[],
  scopes: readonly AttentionScope[],
): readonly string[] {
  return presented
    .filter((notification) => isStale(notification, scopes))
    .map(({ identifier }) => identifier);
}

function isStale(notification: PresentedAttentionNotification, scopes: readonly AttentionScope[]): boolean {
  const fresh = scopes.filter((scope) => scope.readAtEpochMs > notification.deliveredAtEpochMs);
  for (const scope of fresh) {
    const session = scope.sessions.find(({ id }) => id === notification.sessionId);
    if (session === undefined) continue;
    if (session.lifecycle_state !== "running" || session.archived_at_epoch_ms !== null) return true;
    const status = scope.agentStatuses.find(({ sessionId }) => sessionId === notification.sessionId)?.status;
    return status !== undefined && !stillNeedsAttention(notification.attentionKind, status);
  }
  // A Session absent from its own Mac's fresh read was closed or removed there.
  return notification.connectionId !== undefined
    && fresh.some(({ connectionId }) => connectionId === notification.connectionId);
}

function stillNeedsAttention(kind: AgentAttentionKind, status: AgentStatus): boolean {
  if (status === "unknown") return true;
  // Idle after a finished turn is ambiguous for review: nothing records whether
  // the user looked at the result, so only a new turn retires the alert.
  return kind === "needsInput"
    ? status === "awaitingInput"
    : status !== "working" && status !== "awaitingInput" && status !== "compacting";
}

function attentionData(value: unknown): {
  connectionId?: string;
  sessionId: string;
  attentionKind: AgentAttentionKind;
} | undefined {
  if (!isRecord(value) || value.chatProjectId !== undefined && value.chatProjectId !== null) return undefined;
  const sessionId = nonEmptyString(value.sessionId);
  const attentionKind = value.attentionKind;
  if (sessionId === undefined || (attentionKind !== "needsInput" && attentionKind !== "needsReview")) {
    return undefined;
  }
  const connectionId = nonEmptyString(value.connectionId);
  return { ...(connectionId === undefined ? {} : { connectionId }), sessionId, attentionKind };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
