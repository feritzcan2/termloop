import type { ConnectionProfileSummary, ConnectionSourceState } from "../../connection-profile-types.js";

export type ConnectionSnapshotRefresh =
  | { kind: "refresh" }
  | { kind: "retain"; state: Exclude<ConnectionSourceState, "connected">; message?: string };

/**
 * Subscriptions own reconnect backoff. Snapshot refreshes retain an unavailable
 * source until its subscription reports connected again, instead of opening a
 * second retry loop for every unrelated projection invalidation.
 */
export function connectionSnapshotRefresh(
  profile: Pick<ConnectionProfileSummary, "state" | "message">,
): ConnectionSnapshotRefresh {
  if (profile.state === "connecting" || profile.state === "offline") {
    return {
      kind: "retain",
      state: profile.state,
      ...(profile.message ? { message: profile.message } : {}),
    };
  }
  return { kind: "refresh" };
}
