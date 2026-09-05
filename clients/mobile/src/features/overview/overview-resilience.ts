import type { ConnectionAvailability, MobileOverview } from "../../application/ports";

export type OverviewLoad = "idle" | "loading" | "ready" | "failed";

export interface ConnectionOverviewSnapshot {
  load: OverviewLoad;
  error: string | undefined;
  overview: MobileOverview | undefined;
  refreshing: boolean;
  reviewReadySessionIds: ReadonlySet<string>;
  readAtEpochMs: number | undefined;
}

export function emptyOverviewSnapshot(): ConnectionOverviewSnapshot {
  return {
    load: "idle",
    error: undefined,
    overview: undefined,
    refreshing: false,
    reviewReadySessionIds: new Set(),
    readAtEpochMs: undefined,
  };
}

export function snapshotWhileUnavailable(
  availability: ConnectionAvailability,
  previous: ConnectionOverviewSnapshot | undefined,
): ConnectionOverviewSnapshot {
  return availability === "offline" && previous?.overview !== undefined
    ? { ...previous, load: "ready", error: undefined, refreshing: false }
    : emptyOverviewSnapshot();
}

export function snapshotWhileBackgrounded(
  previous: ConnectionOverviewSnapshot | undefined,
): ConnectionOverviewSnapshot {
  return { ...(previous ?? emptyOverviewSnapshot()), refreshing: false };
}

/// The native pull-to-refresh spinner represents a gesture, not every background
/// projection read. Foreground recovery and daemon invalidations still refresh the
/// data, but keeping the gesture spinner active for those reads leaves the list
/// visibly pulled down if iOS suspends the request again.
export function refreshIndicatorForOverviewRead(
  explicitlyRequested: boolean,
  previous: ConnectionOverviewSnapshot | undefined,
): boolean {
  return explicitlyRequested && previous?.overview !== undefined;
}
