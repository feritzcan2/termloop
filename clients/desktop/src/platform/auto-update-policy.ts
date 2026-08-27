export function autoUpdateSupported(
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
  appImagePath: string | undefined = process.env.APPIMAGE,
): boolean {
  if (!isPackaged) return false;
  if (platform === "darwin" || platform === "win32") return true;
  // Debian packages remain owned by the system package manager. The AppImage
  // launcher supplies APPIMAGE, which is the only Linux flavor updated here.
  return platform === "linux" && Boolean(appImagePath);
}
