import type { LaunchAtLoginStatus } from "../launch-at-login.js";

type LoginItemApplication = {
  readonly isPackaged: boolean;
  getLoginItemSettings(): { openAtLogin: boolean; status?: string };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
};

/// Reads the operating system's login item for this executable.
export function launchAtLoginStatus(
  application: LoginItemApplication,
  platform: NodeJS.Platform = process.platform,
): LaunchAtLoginStatus {
  // Electron manages login items only on macOS and Windows.
  if (platform !== "darwin" && platform !== "win32") return { state: "unsupported", reason: "platform" };
  // An unpackaged run is the shared Electron binary started with a script
  // path. Registering it would open a bare Electron window at login.
  if (!application.isPackaged) return { state: "unsupported", reason: "development" };
  const settings = application.getLoginItemSettings();
  const requiresApproval = platform === "darwin" && settings.status === "requires-approval";
  return { state: "available", enabled: settings.openAtLogin || requiresApproval, requiresApproval };
}

/// Adds or removes this executable as a login item and returns what the
/// operating system now reports.
export function setLaunchAtLogin(
  application: LoginItemApplication,
  enabled: boolean,
  platform: NodeJS.Platform = process.platform,
): LaunchAtLoginStatus {
  const current = launchAtLoginStatus(application, platform);
  if (current.state !== "available") throw new Error("launchAtLoginUnsupported");
  application.setLoginItemSettings({ openAtLogin: enabled });
  return launchAtLoginStatus(application, platform);
}
