export type NotificationDestination =
  | {
    readonly kind: "session";
    readonly connectionId?: string;
    readonly projectId?: string;
    readonly sessionId: string;
  }
  | { readonly kind: "steward"; readonly connectionId?: string; readonly projectId: string };

export interface NotificationConnectionScope {
  readonly connectionId: string;
  readonly sessionIds: readonly string[];
  readonly projectIds: readonly string[];
}

export type NotificationRoute =
  | {
    readonly pathname: "/session/[sessionId]";
    readonly params: {
      readonly sessionId: string;
      readonly connectionId: string;
      readonly projectId?: string;
    };
  }
  | {
    readonly pathname: "/project/[projectId]";
    readonly params: { readonly projectId: string; readonly connectionId: string };
  };

/// APNs data is untrusted input. Resolve only the identifiers needed for a known
/// mobile route, and keep Steward chat's synthetic Session ID out of the terminal.
export function notificationDestination(data: unknown): NotificationDestination | undefined {
  if (!isRecord(data)) return undefined;
  const connectionId = nonEmptyString(data.connectionId);
  const projectId = nonEmptyString(data.projectId);

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
    ...(projectId === undefined ? {} : { projectId }),
    sessionId,
  };
}

/// Expo Notifications exposes Expo-shaped remote data through `content.data`,
/// while direct APNs custom fields remain available on the push trigger payload.
/// Accept either representation so notification taps survive both delivery paths.
export function notificationDestinationFromRemote(
  contentData: unknown,
  trigger: unknown,
): NotificationDestination | undefined {
  const contentDestination = notificationDestination(contentData);
  if (contentDestination !== undefined) return contentDestination;
  return isRecord(trigger) ? notificationDestination(trigger.payload) : undefined;
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

/// A notification is an explicit navigation intent. Its exact target is pushed so
/// Back always has an in-app destination; `push` also creates a fresh dynamic route
/// rather than reusing an older Session with stale params.
export function notificationRoute(
  destination: NotificationDestination,
  connectionId: string,
): NotificationRoute {
  return destination.kind === "session"
    ? {
      pathname: "/session/[sessionId]",
      params: {
        sessionId: destination.sessionId,
        connectionId,
        ...(destination.projectId === undefined ? {} : { projectId: destination.projectId }),
      },
    }
    : {
      pathname: "/project/[projectId]",
      params: { projectId: destination.projectId, connectionId },
    };
}

/// A notification can launch the app without useful native-stack history. Seed the
/// owning Project directly beneath an Agent so both the header and iOS back gesture
/// have the same deterministic destination.
export function notificationRouteStack(
  destination: NotificationDestination,
  connectionId: string,
): readonly [NotificationRoute] | readonly [NotificationRoute, NotificationRoute] {
  const target = notificationRoute(destination, connectionId);
  if (destination.kind !== "session" || destination.projectId === undefined) return [target];
  return [{
    pathname: "/project/[projectId]",
    params: { projectId: destination.projectId, connectionId },
  }, target];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
