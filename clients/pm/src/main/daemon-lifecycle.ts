// Supervises the `termloop-pm-daemon` child this application starts. Every
// process and filesystem primitive is injected (see
// `src/platform/daemon-process.ts`) so the start, discovery, and shutdown
// ladder stays unit-testable. The discovery record, and with it the bearer,
// never leaves main.
import { CONTRACT_IDENTITY } from "@termloop/pm-contract/pm";

export type PmDiscovery = {
  protocolVersion: string;
  controlUrl: string;
  terminalUrl: string;
  token: string;
  scope: string;
  runtimeEpoch: number;
  pid: number;
};

export type PmDaemonChild = {
  pid: number | undefined;
  /** Resolves with the first stdout line (the discovery path), or undefined when stdout closes first. */
  firstLine: Promise<string | undefined>;
  onExit(listener: (code: number | null) => void): void;
  /** Graceful request: SIGTERM on unix, TerminateProcess on Windows. */
  terminate(): void;
  kill(): void;
};

export type PmDaemonDeps = {
  spawnDaemon(): PmDaemonChild;
  readDiscovery(path: string): Promise<unknown>;
  delay(ms: number): Promise<void>;
};

export type PmDaemonLimits = { readyTimeoutMs: number; shutdownWaitMs: number; pollMs: number };

export const DEFAULT_PM_DAEMON_LIMITS: PmDaemonLimits = { readyTimeoutMs: 20_000, shutdownWaitMs: 3_000, pollMs: 100 };

export class PmDaemonSupervisor {
  #child: PmDaemonChild | undefined;
  #exited = false;
  #stopping = false;

  constructor(
    readonly deps: PmDaemonDeps,
    readonly onUnexpectedExit: (code: number | null) => void = () => {},
    readonly limits: PmDaemonLimits = DEFAULT_PM_DAEMON_LIMITS,
  ) {}

  /** Spawns the daemon and resolves with its validated discovery record. */
  async start(): Promise<PmDiscovery> {
    if (this.#child) throw new Error("the PM daemon is already started");
    const child = this.deps.spawnDaemon();
    this.#child = child;
    this.#exited = false;
    let exitCode: number | null = null;
    child.onExit((code) => {
      this.#exited = true;
      exitCode = code;
      if (this.#child === child && !this.#stopping) this.onUnexpectedExit(code);
    });
    const timeout = this.deps.delay(this.limits.readyTimeoutMs).then(() => "timeout" as const);
    const line = await Promise.race([child.firstLine, timeout]);
    if (line === "timeout" || line === undefined || line.trim() === "") {
      child.kill();
      this.#child = undefined;
      throw new Error(line === "timeout"
        ? "the PM daemon did not publish its discovery file in time"
        : `the PM daemon exited before it was ready (exit code ${String(exitCode)}); another PM daemon may hold the instance lease`);
    }
    try {
      return parseDiscovery(await this.deps.readDiscovery(line.trim()));
    } catch (error) {
      child.kill();
      this.#child = undefined;
      throw error;
    }
  }

  /** Graceful terminate, a bounded wait, then a hard kill. */
  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    this.#child = undefined;
    if (!child || this.#exited) return;
    child.terminate();
    for (let waited = 0; waited < this.limits.shutdownWaitMs && !this.#exited; waited += this.limits.pollMs) {
      await this.deps.delay(this.limits.pollMs);
    }
    if (!this.#exited) child.kill();
  }
}

/** Validates a discovery document against the contract this client speaks. */
export function parseDiscovery(value: unknown): PmDiscovery {
  if (typeof value !== "object" || value === null) throw new Error("the PM discovery file is not an object");
  const record = value as Record<string, unknown>;
  const text = (key: string) => {
    const field = record[key];
    if (typeof field !== "string" || field.length === 0) throw new Error(`the PM discovery file lacks ${key}`);
    return field;
  };
  const protocolVersion = text("protocolVersion");
  if (protocolVersion !== CONTRACT_IDENTITY) {
    throw new Error("the PM daemon speaks a different protocol version; rebuild it from this checkout");
  }
  const controlUrl = text("controlUrl");
  const terminalUrl = text("terminalUrl");
  for (const url of [controlUrl, terminalUrl]) {
    if (!/^ws:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error("the PM daemon is not on loopback");
  }
  const runtimeEpoch = record["runtimeEpoch"];
  const pid = record["pid"];
  if (typeof runtimeEpoch !== "number" || !Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < 0) {
    throw new Error("the PM discovery file lacks runtimeEpoch");
  }
  return {
    protocolVersion,
    controlUrl,
    terminalUrl,
    token: text("token"),
    scope: text("scope"),
    runtimeEpoch,
    pid: typeof pid === "number" ? pid : 0,
  };
}
