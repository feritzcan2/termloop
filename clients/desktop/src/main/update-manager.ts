import type { UpdateDriver } from "../platform/auto-update.js";

export type UpdateManagerDependencies = {
  driver: UpdateDriver;
  schedule(delayMs: number, task: () => void): void;
  confirmRestart(version: string): Promise<boolean>;
  prepareForRestart(): Promise<void>;
  initialDelayMs?: number;
  checkIntervalMs?: number;
};

export const DEFAULT_UPDATE_INITIAL_DELAY_MS = 15_000;
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/**
 * Owns the small, non-durable update state machine. The privileged updater,
 * clock, and dialog are injected so update checks never widen renderer
 * authority and the restart ordering remains directly testable.
 */
export class UpdateManager {
  readonly #dependencies: UpdateManagerDependencies;
  #checking = false;
  #offeringRestart = false;

  constructor(dependencies: UpdateManagerDependencies) {
    this.#dependencies = dependencies;
    dependencies.driver.listen({
      downloaded: (version) => { void this.#offerRestart(version); },
    });
  }

  start(): void {
    this.#schedule(this.#dependencies.initialDelayMs ?? DEFAULT_UPDATE_INITIAL_DELAY_MS);
  }

  #schedule(delayMs: number): void {
    this.#dependencies.schedule(delayMs, () => { void this.#check(); });
  }

  async #check(): Promise<void> {
    if (this.#checking) return;
    this.#checking = true;
    try {
      await this.#dependencies.driver.check();
    } catch {
      // Periodic update failures are intentionally silent. The next bounded
      // check retries, and raw network errors/URLs never enter application logs.
    } finally {
      this.#checking = false;
      this.#schedule(this.#dependencies.checkIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS);
    }
  }

  async #offerRestart(version: string): Promise<void> {
    if (this.#offeringRestart) return;
    this.#offeringRestart = true;
    try {
      if (!await this.#dependencies.confirmRestart(version)) return;
      await this.#dependencies.prepareForRestart();
      this.#dependencies.driver.install();
    } finally {
      this.#offeringRestart = false;
    }
  }
}
