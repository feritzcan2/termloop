import {
  BrowserWindow,
  MessageChannelMain,
  utilityProcess,
  type UtilityProcess,
  type WebFrameMain,
} from "electron";
import path from "node:path";
import type { DesktopConnectionConfig } from "./connection-profiles.js";

type GatewayState = "connecting" | "connected" | "connectionLost" | "gatewayProcessLost";

export class TerminalGatewaySupervisor {
  #process: UtilityProcess | undefined;
  #pendingProcess: UtilityProcess | undefined;
  #spawnPromise: Promise<UtilityProcess> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;

  constructor(
    private readonly gatewayEntry: string,
    private readonly profileId: string,
    private readonly resolveConnectionConfig: () => Promise<DesktopConnectionConfig | undefined>,
  ) {}

  async attach(
    frame: WebFrameMain,
    requestId: string,
    sessionId: string,
    runtimeEpoch: number,
  ): Promise<void> {
    const config = await this.resolveConnectionConfig();
    if (!config) throw new Error("terminalUnavailable");
    const child = await this.#ensureProcess();
    child.postMessage({
      type: "configure",
      connectionKind: config.kind,
      terminalUrl: config.terminalUrl,
      terminalToken: config.terminalToken,
      ...(config.kind === "remote" ? {
        accessProfileId: config.profileId,
        accessCredential: config.credential,
      } : {}),
    });
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage({ type: "attach", sessionId, runtimeEpoch }, [port1]);
    frame.postMessage("termloop:terminal-port", { requestId }, [port2]);
  }

  stop(): void {
    this.#generation += 1;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const process = this.#process;
    const pending = this.#pendingProcess;
    this.#process = undefined;
    this.#pendingProcess = undefined;
    this.#spawnPromise = undefined;
    if (process || pending) this.#broadcast("gatewayProcessLost");
    if (pending && pending !== process) pending.kill();
    process?.kill();
  }

  async #ensureProcess(): Promise<UtilityProcess> {
    if (this.#process) return this.#process;
    if (this.#spawnPromise) return this.#spawnPromise;
    const generation = this.#generation;
    this.#spawnPromise = new Promise<UtilityProcess>((resolve, reject) => {
      const child = utilityProcess.fork(this.gatewayEntry, [], {
        serviceName: "TermLoop Terminal Gateway",
        stdio: "pipe",
      });
      this.#pendingProcess = child;
      child.stdout?.resume();
      let launchSettled = false;
      let launched = false;
      const failLaunch = (message: string) => {
        if (launchSettled) return;
        launchSettled = true;
        if (this.#pendingProcess === child) {
          this.#pendingProcess = undefined;
          if (generation === this.#generation) this.#spawnPromise = undefined;
        }
        child.kill();
        reject(new Error(message));
      };
      const handleSpawn = () => {
        if (generation !== this.#generation) {
          failLaunch("terminal gateway launch was superseded");
          return;
        }
        if (launchSettled) {
          child.kill();
          return;
        }
        launchSettled = true;
        launched = true;
        if (this.#pendingProcess === child) this.#pendingProcess = undefined;
        this.#process = child;
        this.#spawnPromise = undefined;
        resolve(child);
      };
      child.once("spawn", handleSpawn);
      child.once("error", () => {
        if (!launched) failLaunch("terminal gateway launch failed");
      });
      child.on("message", (message: unknown) => this.#handleMessage(child, message));
      child.on("exit", () => {
        if (!launched) {
          failLaunch("terminal gateway exited before launch");
          return;
        }
        if (this.#process === child) {
          this.#process = undefined;
          this.#spawnPromise = undefined;
          this.#broadcast("gatewayProcessLost");
        }
      });
      child.stderr?.on("data", (chunk) => console.error(`[terminal-gateway] ${String(chunk).trimEnd()}`));
    });
    return this.#spawnPromise;
  }

  #handleMessage(child: UtilityProcess, message: unknown): void {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const value = message as { type: string; state?: GatewayState };
    if (value.type === "state" && value.state) {
      this.#broadcast(value.state);
      if (value.state === "connectionLost") this.#scheduleReconfigure(child);
    }
  }

  #scheduleReconfigure(child: UtilityProcess): void {
    if (this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(async () => {
      this.#reconnectTimer = undefined;
      if (this.#process !== child) return;
      try {
        const config = await this.resolveConnectionConfig();
        if (config) {
          child.postMessage({
            type: "configure",
            connectionKind: config.kind,
            terminalUrl: config.terminalUrl,
            terminalToken: config.terminalToken,
            ...(config.kind === "remote" ? {
              accessProfileId: config.profileId,
              accessCredential: config.credential,
            } : {}),
          });
          return;
        }
      } catch {
        // SSH deliberately rejects while its bounded reconnect backoff is
        // active. Keep supervising instead of turning that transient state
        // into an unhandled timer rejection and a permanently stale port.
      }
      this.#scheduleReconfigure(child);
    }, 750);
  }

  #broadcast(state: GatewayState): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("termloop:gateway-state", { profileId: this.profileId, state });
      }
    }
  }
}

/** Keeps one isolated terminal utility process per enabled connection source. */
export class TerminalGatewayRegistry {
  readonly #supervisors = new Map<string, TerminalGatewaySupervisor>();

  constructor(
    private readonly entry: string,
    private readonly resolveConnectionConfig: (
      profileId: string,
    ) => Promise<DesktopConnectionConfig | undefined>,
  ) {}

  async attach(
    profileId: string,
    frame: WebFrameMain,
    requestId: string,
    sessionId: string,
    runtimeEpoch: number,
  ): Promise<void> {
    await this.#supervisor(profileId).attach(frame, requestId, sessionId, runtimeEpoch);
  }

  retain(profileIds: ReadonlySet<string>): void {
    for (const profileId of [...this.#supervisors.keys()]) {
      if (!profileIds.has(profileId)) this.stopProfile(profileId);
    }
  }

  stopProfile(profileId: string): void {
    this.#supervisors.get(profileId)?.stop();
    this.#supervisors.delete(profileId);
  }

  stop(): void {
    for (const supervisor of this.#supervisors.values()) supervisor.stop();
    this.#supervisors.clear();
  }

  #supervisor(profileId: string): TerminalGatewaySupervisor {
    let supervisor = this.#supervisors.get(profileId);
    if (supervisor) return supervisor;
    supervisor = new TerminalGatewaySupervisor(
      this.entry,
      profileId,
      () => this.resolveConnectionConfig(profileId),
    );
    this.#supervisors.set(profileId, supervisor);
    return supervisor;
  }
}

export function gatewayEntry(directory: string): string {
  return path.join(directory, "terminal-gateway.js");
}
