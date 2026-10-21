import electronUpdater from "electron-updater";

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

  return {
    listen(listeners: UpdateDriverListeners): void {
      autoUpdater.on("download-progress", (progress) => listeners.progress(progress.percent));
      autoUpdater.on("update-downloaded", (event) => listeners.downloaded(event.version));
    },
    async check(): Promise<UpdateCheck | undefined> {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable || !result.downloadPromise) return undefined;
      return { version: result.updateInfo.version, download: result.downloadPromise.then(() => undefined) };
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
