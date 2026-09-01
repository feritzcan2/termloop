/** Cancellable delay the throttle uses to close a coalescing window. */
export type RefreshTimerHandle = { readonly cancel: () => void };

export type RefreshTimerScheduler = (
  run: () => void,
  delayMs: number,
) => RefreshTimerHandle;

/** Shortest window an assistant refetch round may repeat in. */
export const ASSISTANT_REFRESH_COALESCE_MS = 250;

/**
 * PTY liveness keeps `session` and `agentStatus` moving while an executor
 * streams output. This throttle bounds React notification frequency; the
 * composition-owned read coordinator separately single-flights named reads
 * until their remote round completes.
 */
export class AssistantRefreshThrottle {
  #cooldown: RefreshTimerHandle | undefined;
  #queued = false;

  constructor(
    private readonly refresh: () => void,
    private readonly schedule: RefreshTimerScheduler,
    private readonly windowMs: number = ASSISTANT_REFRESH_COALESCE_MS,
  ) {}

  request(): void {
    if (this.#cooldown) {
      this.#queued = true;
      return;
    }
    this.refresh();
    this.#openWindow();
  }

  /** Drops the pending window so a torn-down subscription cannot refresh. */
  dispose(): void {
    this.#cooldown?.cancel();
    this.#cooldown = undefined;
    this.#queued = false;
  }

  #openWindow(): void {
    this.#cooldown = this.schedule(() => {
      this.#cooldown = undefined;
      if (!this.#queued) return;
      this.#queued = false;
      this.refresh();
      this.#openWindow();
    }, this.windowMs);
  }
}

export function timeoutRefreshScheduler(run: () => void, delayMs: number): RefreshTimerHandle {
  const handle = setTimeout(run, delayMs);
  return { cancel: () => clearTimeout(handle) };
}
