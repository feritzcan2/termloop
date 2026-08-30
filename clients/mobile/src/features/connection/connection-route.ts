/// Adds the owning Mac to every Project-scoped route. Session routes are retained
/// by Expo Router, while the globally selected Mac changes as the user browses;
/// carrying this identity is what lets a returned screen restore its own scope.
export function connectionRouteParams<T extends Record<string, string>>(
  connectionId: string | undefined,
  params: T,
): T & { connectionId?: string } {
  return connectionId === undefined ? params : { ...params, connectionId };
}
