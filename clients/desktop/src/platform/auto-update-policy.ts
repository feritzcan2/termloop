export function autoUpdateSupported(
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Linux desktop builds are no longer published, so only macOS and Windows
  // have a live update feed.
  return isPackaged && (platform === "darwin" || platform === "win32");
}
