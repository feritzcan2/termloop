import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

export type UpdateDriverListeners = {
  downloaded(version: string): void;
};

export type UpdateDriver = {
  listen(listeners: UpdateDriverListeners): void;
  check(): Promise<void>;
  install(): void;
};

export function createAutoUpdateDriver(): UpdateDriver {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = null;

  return {
    listen(listeners: UpdateDriverListeners): void {
      autoUpdater.on("update-downloaded", (event) => listeners.downloaded(event.version));
    },
    async check(): Promise<void> {
      await autoUpdater.checkForUpdates();
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
