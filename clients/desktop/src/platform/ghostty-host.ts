import { createRequire } from "node:module";
import path from "node:path";
import type { GhosttyShellShortcut } from "../ghostty-shell-shortcut.js";

/// Typed interface of the native Ghostty host addon
/// (native/ghostty-host). All calls must happen on the Electron main
/// process main thread; the addon drives AppKit and libghostty directly.
export type GhosttySurfaceGrid = {
  rows: number;
  cols: number;
  cellWidthPx: number;
  cellHeightPx: number;
  widthPx: number;
  heightPx: number;
};

export type GhosttyHostAddon = {
  initApp(options: {
    configFile?: string;
    onSurfaceClosed?(surfaceId: number): void;
    onOutputConsumed?(surfaceId: number, bytes: number): void;
    onShellShortcut?(shortcut: GhosttyShellShortcut): void;
  }): void;
  createSurface(options: {
    handle: Buffer;
    x: number;
    y: number;
    width: number;
    height: number;
  }): { id: number; hostFd: number; rows: number; cols: number };
  setSurfaceFrame(id: number, x: number, y: number, width: number, height: number): { rows: number; cols: number };
  setSurfaceVisible(id: number, visible: boolean): void;
  setSurfaceColorScheme(id: number, theme: "dark" | "light"): void;
  focusSurface(id: number): void;
  surfaceSize(id: number): GhosttySurfaceGrid;
  surfacePng(id: number): Buffer | undefined;
  surfaceText(id: number): string | undefined;
  destroySurface(id: number): void;
  surfaceCount(): number;
};

/// Loads the native addon, or returns undefined when unavailable (wrong
/// platform, addon not built, load failure). Never throws: an unhealthy
/// native layer downgrades to the xterm renderer.
export function loadGhosttyHostAddon(appPath: string): GhosttyHostAddon | undefined {
  if (process.platform !== "darwin") return undefined;
  const packaged = path.basename(appPath) === "app.asar";
  const addonPath = process.env.TERMLOOP_GHOSTTY_ADDON
    ?? (packaged
      ? path.join(process.resourcesPath, "native", "ghostty-host", "ghostty_host.node")
      : path.join(appPath, "native", "ghostty-host", "build", "Release", "ghostty_host.node"));
  // Ghostty needs its resources (terminfo, themes) before app init.
  process.env.GHOSTTY_RESOURCES_DIR ??= process.env.TERMLOOP_GHOSTTY_RESOURCES
    ?? (packaged
      ? path.join(process.resourcesPath, "ghostty")
      : path.join(appPath, "..", "..", "vendor", "ghostty", "zig-out", "share", "ghostty"));
  try {
    const requireAddon = createRequire(import.meta.url);
    return requireAddon(addonPath) as GhosttyHostAddon;
  } catch {
    return undefined;
  }
}
