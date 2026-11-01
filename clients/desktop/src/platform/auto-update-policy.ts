import { existsSync } from "node:fs";
import path from "node:path";

export function autoUpdateSupported(
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
  appImagePath: string | undefined = process.env.APPIMAGE,
  windowsInstalled: () => boolean = () => windowsInstallerOwns(process.execPath),
): boolean {
  if (!isPackaged) return false;
  if (platform === "darwin") return true;
  // The NSIS installer always updates the installed copy under Programs. A
  // `--dir` checkout build would download and run it, then reopen unchanged
  // and offer the same update again, so only the installed app updates.
  if (platform === "win32") return windowsInstalled();
  // Debian packages remain owned by the system package manager. The AppImage
  // launcher supplies APPIMAGE, which is the only Linux flavor updated here.
  return platform === "linux" && Boolean(appImagePath);
}

/// NSIS places "Uninstall <product>.exe" beside the application executable.
export function windowsInstallerOwns(executablePath: string): boolean {
  const directory = path.dirname(executablePath);
  return existsSync(path.join(directory, `Uninstall ${path.basename(executablePath)}`));
}
