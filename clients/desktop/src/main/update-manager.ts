import type { UpdateDriver } from "../platform/auto-update.js";
import type { UpdateStatus } from "../update-status.js";

export type UpdateManagerDependencies = {
  driver: UpdateDriver;
  schedule(delayMs: number, task: () => void): void;
  confirmRestart(version: string): Promise<boolean>;
  prepareForRestart(): Promise<void>;
  statusChanged?(status: UpdateStatus): void;
  initialDelayMs?: number;
  checkIntervalMs?: number;
};

export const DEFAULT_UPDATE_INITIAL_DELAY_MS = 15_000;
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Owns the small, non-durable update state machine. The privileged updater,
 * clock, and dialog are injected so update checks never widen renderer
 * authority and the restart ordering remains directly testable.
 */
export class UpdateManager {
  readonly #dependencies: UpdateManagerDependencies;
  #checking = false;
  #offeringRestart = false;
  #downloadedVersion: string | undefined;
  #status: UpdateStatus = { state: "idle" };

  constructor(dependencies: UpdateManagerDependencies) {
    this.#dependencies = dependencies;
    dependencies.driver.listen({
      progress: (percent) => {
        if (this.#status.state !== "downloading") return;
        const rounded = Math.max(0, Math.min(100, Math.floor(percent)));
        if (rounded !== this.#status.percent) this.#publish({ ...this.#status, percent: rounded });
      },
      downloaded: (version) => {
        this.#downloadedVersion = version;
        if (this.#status.state !== "installing") this.#publish({ state: "ready", version });
        void this.#offerRestart(version);
      },
    });
  }

  status(): UpdateStatus {
    return this.#status;
  }

  start(): void {
    this.#schedule(this.#dependencies.initialDelayMs ?? DEFAULT_UPDATE_INITIAL_DELAY_MS);
  }

  /** A user-requested check; it never opens the restart dialog. */
  async checkNow(): Promise<void> {
    await this.#check(false);
  }

  /** A user-requested restart; the click is the confirmation. */
  async install(): Promise<void> {
    const version = this.#downloadedVersion;
    if (!version || this.#status.state === "installing") return;
    this.#publish({ state: "installing", version });
    await this.#dependencies.prepareForRestart();
    this.#dependencies.driver.install();
  }

  #schedule(delayMs: number): void {
    this.#dependencies.schedule(delayMs, () => {
      void this.#check(true).finally(() => {
        this.#schedule(this.#dependencies.checkIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS);
      });
    });
  }

  async #check(offerDownloaded: boolean): Promise<void> {
    // A download in flight already answers the check, and installing is final.
    if (this.#checking || this.#status.state === "downloading" || this.#status.state === "installing") return;
    // A downloaded update is offered again instead of fetched again; it also
    // installs on the next quit if every offer is declined.
    if (this.#downloadedVersion) {
      if (offerDownloaded) await this.#offerRestart(this.#downloadedVersion);
      return;
    }
    this.#checking = true;
    this.#publish({ state: "checking" });
    try {
      const update = await this.#dependencies.driver.check();
      if (!update) {
        this.#publish({ state: "current" });
        return;
      }
      if (!this.#downloadedVersion) this.#publish({ state: "downloading", version: update.version, percent: null });
      void update.download.catch(() => {
        if (this.#status.state === "downloading") this.#publish({ state: "failed", version: update.version });
      });
    } catch {
      // Raw network errors/URLs never enter application logs or the renderer;
      // the next bounded check retries.
      this.#publish({ state: "failed", version: null });
    } finally {
      this.#checking = false;
    }
  }

  async #offerRestart(version: string): Promise<void> {
    if (this.#offeringRestart) return;
    this.#offeringRestart = true;
    try {
      if (!await this.#dependencies.confirmRestart(version)) return;
      await this.install();
    } finally {
      this.#offeringRestart = false;
    }
  }

  #publish(status: UpdateStatus): void {
    this.#status = status;
    this.#dependencies.statusChanged?.(status);
  }
}
