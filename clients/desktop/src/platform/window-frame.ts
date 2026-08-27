// Window chrome is per-OS: macOS hides the native title bar behind the
// renderer's drag strip and keeps the inset traffic lights, while Windows and
// Linux use the default native frame so the OS provides its own window
// controls. Electron degrades "hiddenInset" to a frameless window without any
// controls on non-mac platforms, so the option must never reach them.
export function windowFrameOptions(
  platform: NodeJS.Platform = process.platform,
): { titleBarStyle: "hiddenInset" } | Record<string, never> {
  return platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {};
}
