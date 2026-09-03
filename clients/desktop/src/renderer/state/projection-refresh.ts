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

/**
 * Gives every projection owner its own serialized refresh lane. A slow remote
 * source cannot hold back local or peer sources, while repeated invalidations
 * for the same owner still collapse into one completion-aware trailing round.
 */
export class KeyedProjectionRefreshQueue<Key> {
  readonly #queues = new Map<Key, {
    refresh: ProjectionRefresh;
    retained: boolean;
    pending?: Promise<void>;
  }>();

  constructor(
    private readonly refreshOnce: (key: Key) => Promise<void>,
    private readonly beforeFirstRefresh: (key: Key) => Promise<void> = () => Promise.resolve(),
  ) {}

  request(key: Key): Promise<void> {
    let entry = this.#queues.get(key);
    if (!entry) {
      entry = {
        refresh: createProjectionRefreshQueue(
          () => this.refreshOnce(key),
          () => this.beforeFirstRefresh(key),
        ),
        retained: true,
      };
      this.#queues.set(key, entry);
    }
    entry.retained = true;
    const pending = entry.refresh();
    entry.pending = pending;
    const release = () => {
      if (entry?.pending !== pending) return;
      delete entry.pending;
      if (!entry.retained && this.#queues.get(key) === entry) this.#queues.delete(key);
    };
    void pending.then(release, release);
    return pending;
  }

  retain(keys: ReadonlySet<Key>): void {
    for (const [key, entry] of this.#queues) {
      if (keys.has(key)) continue;
      entry.retained = false;
      if (!entry.pending) this.#queues.delete(key);
    }
  }
}
