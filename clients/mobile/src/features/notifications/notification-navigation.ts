export type NotificationDestination =
  | { readonly kind: "session"; readonly connectionId?: string; readonly sessionId: string }
  | { readonly kind: "steward"; readonly connectionId?: string; readonly projectId: string };

export interface NotificationConnectionScope {
  readonly connectionId: string;
  readonly sessionIds: readonly string[];
  readonly projectIds: readonly string[];
}

/// APNs data is untrusted input. Resolve only the identifiers needed for a known
/// mobile route, and keep Steward chat's synthetic Session ID out of the terminal.
export function notificationDestination(data: unknown): NotificationDestination | undefined {
  if (!isRecord(data)) return undefined;
  const connectionId = nonEmptyString(data.connectionId);

  const chatProjectId = nonEmptyString(data.chatProjectId);
  if (chatProjectId !== undefined) return {
    kind: "steward",
    ...(connectionId === undefined ? {} : { connectionId }),
    projectId: chatProjectId,
  };

  const sessionId = nonEmptyString(data.sessionId);
  return sessionId === undefined ? undefined : {
    kind: "session",
    ...(connectionId === undefined ? {} : { connectionId }),
    sessionId,
  };
}

/// The entity projection is stronger evidence than a possibly stale push hint. When
/// projections are still loading, a known hint (or the only paired Mac) lets the user
/// continue immediately instead of stranding the tap on Home.
export function resolveNotificationConnectionId(
  destination: NotificationDestination,
  scopes: readonly NotificationConnectionScope[],
): string | undefined {
  const entityMatches = scopes.filter((scope) => destination.kind === "session"
    ? scope.sessionIds.includes(destination.sessionId)
    : scope.projectIds.includes(destination.projectId));
  if (entityMatches.length === 1) return entityMatches[0]?.connectionId;

  if (destination.connectionId !== undefined
    && scopes.some(({ connectionId }) => connectionId === destination.connectionId)) {
    return destination.connectionId;
  }
  return scopes.length === 1 ? scopes[0]?.connectionId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
