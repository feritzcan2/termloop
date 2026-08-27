// Bundled daemon lifecycle for the packaged desktop flavor.
//
// The packaged application ships `termloop-server` (with its sibling
// `termloop-companion`) under `<resources>/daemon`. This module decides
// whether the desktop should manage that daemon and supervises the spawned
// child. Every process, filesystem, and network primitive is injected so the
// branching and supervision logic stays unit-testable; the privileged
// implementations live in `src/platform/daemon-runtime.ts`. The desktop still
// only ever connects through discovery — this module never reads or forwards
// tokens itself.

export type DaemonChild = {
  pid: number | undefined;
  onExit(listener: (code: number | null) => void): void;
  terminate(): void;
};

export type BundledDaemonMode = "manage" | "clientOnly";

/**
 * The bundled daemon is managed only by a packaged application whose
 * resources actually contain the server binary, and only when no
 * TERMLOOP_CONTROL_URL override designates an externally owned control plane.
 * Development and client-only flows therefore never reach the spawn path.
 */
export function bundledDaemonMode(input: {
  isPackaged: boolean;
  envControlUrl: string | undefined;
  bundledServerExists: boolean;
}): BundledDaemonMode {
  if (!input.isPackaged) return "clientOnly";
  if (input.envControlUrl !== undefined && input.envControlUrl !== "") return "clientOnly";
  if (!input.bundledServerExists) return "clientOnly";
  return "manage";
}

/**
 * Restarting running provider TUIs is daemon-owner lifecycle work. A desktop
 * connected to an externally owned daemon (including every remote profile)
 * must never trigger it merely because its renderer connected.
 */
export function shouldRestartAgentsForClientLaunch(input: {
  daemonMode: BundledDaemonMode;
  smokeRun: boolean;
}): boolean {
  return input.daemonMode === "manage" && !input.smokeRun;
}

export type BundledDaemonState =
  | "idle"
  | "external"
  | "starting"
  | "running"
  | "failed"
  | "stopped";

export type BundledDaemonLimits = {
  readyPollMs: number;
  readyTimeoutMs: number;
  maxSpawnAttempts: number;
  backoffMs: number;
  shutdownWaitMs: number;
};

export const DEFAULT_BUNDLED_DAEMON_LIMITS: BundledDaemonLimits = {
  readyPollMs: 250,
  readyTimeoutMs: 15_000,
  maxSpawnAttempts: 3,
  backoffMs: 500,
  shutdownWaitMs: 3_000,
};

export type BundledDaemonDeps = {
  /** Reads discovery and pings the control plane; never surfaces the token. */
  probeDaemonAlive(): Promise<boolean>;
  spawnDaemon(): DaemonChild;
  delay(ms: number): Promise<void>;
  /**
   * Sends the Full-scope `system.shutdown` control command so the daemon can
   * reach its graceful path on every OS (Windows has no SIGTERM equivalent
   * short of a hard TerminateProcess). Resolves true when the daemon accepted
   * the request. Only ever invoked for a child this supervisor spawned; an
   * external or client-only daemon is never asked to shut down.
   */
  requestDaemonShutdown(): Promise<boolean>;
};

export class BundledDaemonSupervisor {
  #state: BundledDaemonState = "idle";
  #child: DaemonChild | undefined;
  #attempts = 0;
  #stopping = false;

  constructor(
    readonly deps: BundledDaemonDeps,
    readonly limits: BundledDaemonLimits = DEFAULT_BUNDLED_DAEMON_LIMITS,
  ) {}

  get state(): BundledDaemonState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#stopping) return;
    if (await this.deps.probeDaemonAlive()) {
      // Discovery already points at a live daemon; the existing connection
      // logic uses it directly and this supervisor owns nothing.
      this.#state = "external";
      return;
    }
    await this.#runAttempts();
  }

  /**
   * Graceful shutdown: ask the daemon to shut down over the control plane
   * first (the only graceful path on Windows), wait bounded for the child to
   * exit, then fall back to the existing terminate ladder so the daemon can
   * still release its instance lease and discovery file on unix.
   *
   * The control request is only ever attempted for a child this supervisor
   * spawned; external daemons (and clientOnly flows, which never construct a
   * supervisor) are never sent a shutdown.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    this.#child = undefined;
    this.#state = "stopped";
    if (!child) return;
    let exited = false;
    child.onExit(() => { exited = true; });
    let requestSettled = false;
    let requestAccepted = false;
    void this.deps.requestDaemonShutdown().then(
      (accepted) => {
        requestSettled = true;
        requestAccepted = accepted;
      },
      () => {
        requestSettled = true;
      },
    );
    // One bounded graceful window covers the request round-trip and the exit
    // wait; a refused or failed request falls through to terminate right away.
    for (
      let waited = 0;
      waited < this.limits.shutdownWaitMs && !exited && !(requestSettled && !requestAccepted);
      waited += this.limits.readyPollMs
    ) {
      await this.deps.delay(this.limits.readyPollMs);
    }
    if (exited) return;
    // Fallback ladder: SIGTERM on unix, hard TerminateProcess on Windows.
    child.terminate();
    for (
      let waited = 0;
      waited < this.limits.shutdownWaitMs && !exited;
      waited += this.limits.readyPollMs
    ) {
      await this.deps.delay(this.limits.readyPollMs);
    }
  }

  async #runAttempts(): Promise<void> {
    while (!this.#stopping && this.#attempts < this.limits.maxSpawnAttempts) {
      this.#attempts += 1;
      const outcome = await this.#spawnUntilReady();
      if (outcome === "ready") {
        this.#state = "running";
        return;
      }
      if (outcome === "external") {
        this.#state = "external";
        return;
      }
      if (outcome === "stopped") {
        this.#state = "stopped";
        return;
      }
      if (this.#attempts < this.limits.maxSpawnAttempts) {
        await this.deps.delay(this.limits.backoffMs * this.#attempts);
      }
    }
    if (!this.#stopping) {
      // The attempt budget is exhausted; connection logic keeps degrading to
      // the existing daemonUnavailable state.
      this.#state = "failed";
    }
  }

  async #spawnUntilReady(): Promise<"ready" | "external" | "failed" | "stopped"> {
    let exited = false;
    this.#state = "starting";
    const child = this.deps.spawnDaemon();
    this.#child = child;
    child.onExit(() => {
      exited = true;
      if (this.#child !== child) return;
      this.#child = undefined;
      if (!this.#stopping && this.#state === "running") {
        // Unexpected exit after readiness: restart within the same bounded
        // attempt budget.
        this.#state = "starting";
        void this.#runAttempts();
      }
    });
    for (let waited = 0; waited <= this.limits.readyTimeoutMs; waited += this.limits.readyPollMs) {
      if (this.#stopping) return "stopped";
      if (exited) {
        // A child that exits during startup most likely lost the daemon
        // instance-lease race to another live daemon; if discovery answers,
        // defer to that external daemon instead of counting a failure.
        return (await this.deps.probeDaemonAlive()) ? "external" : "failed";
      }
      if (await this.deps.probeDaemonAlive()) return "ready";
      await this.deps.delay(this.limits.readyPollMs);
    }
    // Never became ready inside the window; reclaim the child before retrying.
    if (this.#child === child) {
      this.#child = undefined;
      child.terminate();
    }
    return "failed";
  }
}
