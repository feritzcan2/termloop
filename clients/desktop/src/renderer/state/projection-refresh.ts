export type ProjectionRefresh = () => Promise<void>;

/** Serializes snapshots and coalesces any overlap into one trailing refresh. */
export function createProjectionRefreshQueue(
  refreshOnce: ProjectionRefresh,
  beforeFirstRefresh: ProjectionRefresh = () => new Promise((resolve) => setTimeout(resolve, 75)),
): ProjectionRefresh {
  let inFlight: Promise<void> | undefined;
  let queued = false;
  return () => {
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    inFlight = (async () => {
      await beforeFirstRefresh();
      do {
        queued = false;
        await refreshOnce();
      } while (queued);
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
