import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BundledDaemonSupervisor,
  bundledDaemonMode,
  shouldRestartAgentsForClientLaunch,
  type BundledDaemonDeps,
  type BundledDaemonLimits,
  type DaemonChild,
} from "../src/main/daemon-lifecycle.js";
import { bundledDaemonServerPath } from "../src/platform/daemon-runtime.js";

const FAST_LIMITS: BundledDaemonLimits = {
  readyPollMs: 1,
  readyTimeoutMs: 20,
  maxSpawnAttempts: 3,
  backoffMs: 1,
  shutdownWaitMs: 5,
};

type FakeChild = {
  child: DaemonChild;
  exit(code: number | null): void;
  terminated(): boolean;
};

function fakeChild(): FakeChild {
  const listeners: Array<(code: number | null) => void> = [];
  let exited = false;
  let exitCode: number | null = null;
  let terminated = false;
  return {
    child: {
      pid: 4242,
      onExit(listener) {
        if (exited) listener(exitCode);
        else listeners.push(listener);
      },
      terminate() {
        terminated = true;
      },
    },
    exit(code) {
      if (exited) return;
      exited = true;
      exitCode = code;
      for (const listener of listeners.splice(0)) listener(code);
    },
    terminated: () => terminated,
  };
}

function makeDeps(overrides: Partial<BundledDaemonDeps> = {}): BundledDaemonDeps & {
  spawned: FakeChild[];
  shutdownRequests: () => number;
} {
  const spawned: FakeChild[] = [];
  let shutdownRequests = 0;
  return {
    spawned,
    shutdownRequests: () => shutdownRequests,
    probeDaemonAlive: async () => false,
    spawnDaemon: () => {
      const entry = fakeChild();
      spawned.push(entry);
      return entry.child;
    },
    delay: async () => {},
    requestDaemonShutdown: async () => {
      shutdownRequests += 1;
      return false;
    },
    ...overrides,
  };
}

describe("bundled daemon mode decision", () => {
  it("manages the daemon only for a packaged app with bundled binaries and no override", () => {
    expect(bundledDaemonMode({
      isPackaged: true,
      envControlUrl: undefined,
      bundledServerExists: true,
    })).toBe("manage");
  });

  it("stays client-only in development, under env override, or without binaries", () => {
    expect(bundledDaemonMode({
      isPackaged: false,
      envControlUrl: undefined,
      bundledServerExists: true,
    })).toBe("clientOnly");
    expect(bundledDaemonMode({
      isPackaged: true,
      envControlUrl: "ws://127.0.0.1:9000",
      bundledServerExists: true,
    })).toBe("clientOnly");
    expect(bundledDaemonMode({
      isPackaged: true,
      envControlUrl: undefined,
      bundledServerExists: false,
    })).toBe("clientOnly");
  });

  it("reserves client-launch Agent restarts for the desktop that owns the daemon", () => {
    expect(shouldRestartAgentsForClientLaunch({
      daemonMode: "manage",
      smokeRun: false,
    })).toBe(true);
    expect(shouldRestartAgentsForClientLaunch({
      daemonMode: "clientOnly",
      smokeRun: false,
    })).toBe(false);
    expect(shouldRestartAgentsForClientLaunch({
      daemonMode: "manage",
      smokeRun: true,
    })).toBe(false);
  });

});

describe("bundled daemon server path", () => {
  it("appends the Windows executable suffix inside the resources daemon directory", () => {
    expect(bundledDaemonServerPath("/resources", "darwin")).toBe(
      path.join("/resources", "daemon", "termloop-server"),
    );
    expect(bundledDaemonServerPath("/resources", "linux")).toBe(
      path.join("/resources", "daemon", "termloop-server"),
    );
    expect(bundledDaemonServerPath("/resources", "win32")).toBe(
      path.join("/resources", "daemon", "termloop-server.exe"),
    );
  });
});

describe("BundledDaemonSupervisor", () => {
  it("leaves a live discovered daemon alone", async () => {
    const deps = makeDeps({ probeDaemonAlive: async () => true });
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.start();
    expect(supervisor.state).toBe("external");
    expect(deps.spawned).toHaveLength(0);
  });

  it("spawns the bundled daemon and reports running once discovery answers", async () => {
    let alive = false;
    const deps = makeDeps({
      probeDaemonAlive: async () => alive,
      spawnDaemon: () => {
        const entry = fakeChild();
        deps.spawned.push(entry);
        // The spawned daemon publishes runtime.json and answers pings.
        alive = true;
        return entry.child;
      },
    });
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.start();
    expect(supervisor.state).toBe("running");
    expect(deps.spawned).toHaveLength(1);
  });

  it("treats an immediate exit with live discovery as an externally owned lease", async () => {
    let probes = 0;
    const deps = makeDeps({
      probeDaemonAlive: async () => {
        probes += 1;
        // The initial probe fails; the post-exit probe finds the lease owner.
        return probes > 1;
      },
      spawnDaemon: () => {
        const entry = fakeChild();
        deps.spawned.push(entry);
        entry.exit(1);
        return entry.child;
      },
    });
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.start();
    expect(supervisor.state).toBe("external");
    expect(deps.spawned).toHaveLength(1);
  });

  it("retries a crashing daemon with bounded attempts and then degrades", async () => {
    const delays: number[] = [];
    const deps = makeDeps({
      delay: async (ms) => {
        delays.push(ms);
      },
      spawnDaemon: () => {
        const entry = fakeChild();
        deps.spawned.push(entry);
        entry.exit(1);
        return entry.child;
      },
    });
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.start();
    expect(supervisor.state).toBe("failed");
    expect(deps.spawned).toHaveLength(FAST_LIMITS.maxSpawnAttempts);
    // Backoff grows between failed attempts.
    expect(delays).toEqual([FAST_LIMITS.backoffMs, FAST_LIMITS.backoffMs * 2]);
  });

  it("terminates a child that never becomes ready before retrying", async () => {
    const deps = makeDeps();
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.start();
    expect(supervisor.state).toBe("failed");
    expect(deps.spawned).toHaveLength(FAST_LIMITS.maxSpawnAttempts);
    expect(deps.spawned.every((entry) => entry.terminated())).toBe(true);
  });

  it("restarts after an unexpected exit within the remaining attempt budget", async () => {
    let alive = false;
    const deps = makeDeps({
      probeDaemonAlive: async () => alive,
      spawnDaemon: () => {
        const entry = fakeChild();
        deps.spawned.push(entry);
        alive = true;
        return entry.child;
      },
    });
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.start();
    expect(supervisor.state).toBe("running");

    alive = false;
    deps.spawned[0]?.exit(1);
    await vi.waitFor(() => expect(deps.spawned).toHaveLength(2));
    await vi.waitFor(() => expect(supervisor.state).toBe("running"));
  });

  it("stops via the control-plane shutdown and never kills a daemon that exits", async () => {
    let alive = false;
    const deps = makeDeps({
      probeDaemonAlive: async () => alive,
      spawnDaemon: () => {
        const entry = fakeChild();
        deps.spawned.push(entry);
        alive = true;
        return entry.child;
      },
      requestDaemonShutdown: async () => {
        // The daemon honors the graceful request and exits on its own.
        deps.spawned[0]?.exit(0);
        return true;
      },
    });
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.start();
    expect(supervisor.state).toBe("running");

    await supervisor.stop();
    expect(supervisor.state).toBe("stopped");
    expect(deps.spawned[0]?.terminated()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deps.spawned).toHaveLength(1);
  });

  it("waits bounded after an accepted control shutdown before falling back to the kill ladder", async () => {
    let alive = false;
    const events: string[] = [];
    const deps = makeDeps({
      probeDaemonAlive: async () => alive,
      delay: async () => {
        events.push("wait");
      },
      requestDaemonShutdown: async () => {
        events.push("controlShutdown");
        return true;
      },
      spawnDaemon: () => {
        const entry = fakeChild();
        const terminate = entry.child.terminate;
        entry.child.terminate = () => {
          events.push("terminate");
          terminate();
        };
        deps.spawned.push(entry);
        alive = true;
        return entry.child;
      },
    });
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.start();
    expect(supervisor.state).toBe("running");

    // The daemon accepts the request but is wedged and never exits.
    await supervisor.stop();
    expect(supervisor.state).toBe("stopped");
    expect(deps.spawned[0]?.terminated()).toBe(true);
    // Ordering: control shutdown first, then the bounded graceful wait, and
    // only then the kill fallback (followed by its own bounded wait).
    expect(events[0]).toBe("controlShutdown");
    const gracefulWaits = FAST_LIMITS.shutdownWaitMs / FAST_LIMITS.readyPollMs;
    expect(events.indexOf("terminate")).toBe(1 + gracefulWaits);
    expect(events.slice(1, 1 + gracefulWaits)).toEqual(Array(gracefulWaits).fill("wait"));
  });

  it("falls back to terminate without burning the graceful budget when the request fails", async () => {
    let alive = false;
    const deps = makeDeps({
      probeDaemonAlive: async () => alive,
      requestDaemonShutdown: async () => {
        throw new Error("daemonUnavailable");
      },
      spawnDaemon: () => {
        const entry = fakeChild();
        const terminate = entry.child.terminate;
        entry.child.terminate = () => {
          terminate();
          // The kill succeeds where the control plane could not.
          entry.exit(0);
        };
        deps.spawned.push(entry);
        alive = true;
        return entry.child;
      },
    });
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.start();
    expect(supervisor.state).toBe("running");

    await supervisor.stop();
    expect(supervisor.state).toBe("stopped");
    expect(deps.spawned[0]?.terminated()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deps.spawned).toHaveLength(1);
  });

  it("never sends a control shutdown when it owns no child (external daemon, clientOnly)", async () => {
    // clientOnly mode never constructs a supervisor at all; an external
    // discovered daemon leaves the supervisor without a spawned child. Both
    // must keep the foreign control plane untouched on quit.
    const deps = makeDeps({ probeDaemonAlive: async () => true });
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.start();
    expect(supervisor.state).toBe("external");

    await supervisor.stop();
    expect(deps.shutdownRequests()).toBe(0);
    expect(deps.spawned).toHaveLength(0);
  });

  it("does not spawn when stopped before start", async () => {
    const deps = makeDeps();
    const supervisor = new BundledDaemonSupervisor(deps, FAST_LIMITS);
    await supervisor.stop();
    await supervisor.start();
    expect(deps.spawned).toHaveLength(0);
    expect(deps.shutdownRequests()).toBe(0);
    expect(supervisor.state).toBe("stopped");
  });
});
