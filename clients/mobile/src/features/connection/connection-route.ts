/// Adds the owning Mac to every Project-scoped route. Session routes are retained
/// by Expo Router, while the globally selected Mac changes as the user browses;
/// carrying this identity is what lets a returned screen restore its own scope.
export function connectionRouteParams<T extends Record<string, string>>(
  connectionId: string | undefined,
  params: T,
): T & { connectionId?: string } {
  return connectionId === undefined ? params : { ...params, connectionId };
}

export interface SessionConnectionScope {
  readonly connectionId: string;
  readonly sessionIds: readonly string[];
}

/// A retained native-stack route can outlive the saved-Mac record that originally
/// created it. Prefer the live projection that owns the Session, then accept a route
/// hint only while it still names a paired Mac. The sole-Mac fallback lets a route
/// settle while that Mac's projection is still loading without trusting a stale ID.
export function resolveSessionRouteConnectionId(
  routeConnectionId: string | undefined,
  sessionId: string,
  scopes: readonly SessionConnectionScope[],
): string | undefined {
  const matches = scopes.filter((scope) => scope.sessionIds.includes(sessionId));
  if (matches.length === 1) return matches[0]?.connectionId;
  if (routeConnectionId !== undefined
    && scopes.some(({ connectionId }) => connectionId === routeConnectionId)) {
    return routeConnectionId;
  }
  return scopes.length === 1 ? scopes[0]?.connectionId : undefined;
}

export type MissingSessionRouteState =
  | "loading"
  | "catalogFailed"
  | "overviewFailed"
  | "connectionBlocked"
  | "missing";

/// The Session screen may spin only while an authoritative read or connection switch
/// can still settle it. Failed, blocked, and conclusively absent routes are terminal
/// presentation states with retry copy rather than permanent ActivityIndicators.
export function missingSessionRouteState(input: {
  readonly catalogLoad: "loading" | "ready" | "failed";
  readonly selectingConnection: boolean;
  readonly targetConnectionSelected: boolean;
  readonly targetConnectionReadable: boolean;
  readonly overviewLoad: "idle" | "loading" | "ready" | "failed";
  readonly unresolvedProjectionsPending: boolean;
  readonly unresolvedProjectionFailed: boolean;
}): MissingSessionRouteState {
  if (input.catalogLoad === "failed") return "catalogFailed";
  if (input.selectingConnection) return "loading";
  if (input.targetConnectionSelected) {
    if (!input.targetConnectionReadable) return "connectionBlocked";
    if (input.overviewLoad === "failed") return "overviewFailed";
    if (input.overviewLoad === "idle" || input.overviewLoad === "loading") return "loading";
    return "missing";
  }
  if (input.catalogLoad === "loading" || input.unresolvedProjectionsPending) return "loading";
  if (input.unresolvedProjectionFailed) return "overviewFailed";
  return "missing";
}
