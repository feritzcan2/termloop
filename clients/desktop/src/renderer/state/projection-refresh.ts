export type ProjectionRefresh = () => Promise<void>;

/**
 * Serializes snapshots and coalesces requests into the next unstarted refresh.
 * Each caller waits only for its round, never for later invalidations to stop.
 */
export function createProjectionRefreshQueue(
  refreshOnce: ProjectionRefresh,
  beforeFirstRefresh: ProjectionRefresh = () => new Promise((resolve) => setTimeout(resolve, 75)),
): ProjectionRefresh {
  let running = false;
  let queued: {
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
  } | undefined;

  const drain = async () => {
    try {
      await beforeFirstRefresh();
    } catch (error) {
      const failed = queued;
      queued = undefined;
      running = false;
      failed?.reject(error);
      return;
    }
    while (queued) {
      const round = queued;
      queued = undefined;
      try {
        await refreshOnce();
        round.resolve();
      } catch (error) {
        round.reject(error);
      }
    }
    running = false;
  };

  return () => {
    if (!queued) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      queued = { promise, resolve, reject };
    }
    const pending = queued.promise;
    if (!running) {
      running = true;
      void drain();
    }
    return pending;
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
