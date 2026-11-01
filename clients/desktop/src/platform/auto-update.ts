import electronUpdater from "electron-updater";

import { updateFailureReason } from "../update-status.js";

const { autoUpdater } = electronUpdater;

export type UpdateDriverListeners = {
  progress(percent: number): void;
  downloaded(version: string): void;
};

/// A newer version found by a check. `download` settles when its automatic
/// download finishes or fails.
export type UpdateCheck = { version: string; download: Promise<void> };

export type UpdateDriver = {
  listen(listeners: UpdateDriverListeners): void;
  check(): Promise<UpdateCheck | undefined>;
  install(): void;
};

export function createAutoUpdateDriver(): UpdateDriver {
  autoUpdater.autoDownload = true;
  // A declined restart still installs on the next ordinary quit, which already
  // stops the managed daemon before Electron emits quit.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = null;
  // electron-updater re-emits every failure as "error"; without a listener the
  // EventEmitter turns that into a second throw. Failures reach the manager
  // through the rejected check or download promise instead.
  autoUpdater.on("error", () => undefined);

  return {
    listen(listeners: UpdateDriverListeners): void {
      autoUpdater.on("download-progress", (progress) => listeners.progress(progress.percent));
      autoUpdater.on("update-downloaded", (event) => listeners.downloaded(event.version));
    },
    async check(): Promise<UpdateCheck | undefined> {
      const result = await autoUpdater.checkForUpdates().catch((cause: unknown) => { throw new UpdateFailure(cause); });
      if (!result?.isUpdateAvailable || !result.downloadPromise) return undefined;
      return {
        version: result.updateInfo.version,
        download: result.downloadPromise.then(() => undefined, (cause: unknown) => { throw new UpdateFailure(cause); }),
      };
    },
    install(): void {
      autoUpdater.quitAndInstall(false, true);
    },
  };
}

export function scheduleAutoUpdateTask(delayMs: number, task: () => void): void {
  const timer = setTimeout(task, delayMs);
  timer.unref();
}

/// A failed check or download carrying only a bounded code. The original error
/// holds URLs and raw network text, so it is dropped here.
export class UpdateFailure extends Error {
  readonly code: string;

  constructor(cause: unknown) {
    const code = updateFailureCode(cause);
    super(`update failed: ${code}`);
    this.name = "UpdateFailure";
    this.code = code;
  }
}

export function updateFailureCode(cause: unknown): string {
  if (cause && typeof cause === "object") {
    const code = updateFailureReason((cause as { code?: unknown }).code);
    if (code) return code;
    const message = (cause as { message?: unknown }).message;
    // Chromium network failures arrive only as text, e.g. "net::ERR_NAME_NOT_RESOLVED".
    const network = typeof message === "string" ? /net::ERR_[A-Z0-9_]+/.exec(message)?.[0] : undefined;
    if (network) return network;
  }
  return "unknown";
}
