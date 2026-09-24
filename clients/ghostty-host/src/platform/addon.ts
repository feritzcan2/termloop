import { createRequire } from "node:module";

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

export type NativeInputPolicy = {
  /** Modifier bits: Shift=1, Control=2, Alt=4, Super=8. */
  bindings?: readonly { keyCode: number; modifiers: number; action: string }[];
  imagePasteAction?: string;
  doubleShiftAction?: string;
  doubleShiftWindowMs?: number;
};

export type GhosttyHostAddon = {
  initApp(options: {
    inputPolicy?: NativeInputPolicy;
    configFile?: string;
    lightConfigFile?: string;
    onSurfaceClosed?(surfaceId: number): void;
    onOutputConsumed?(surfaceId: number, bytes: number): void;
    onShellShortcut?(shortcut: string): void;
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
  scrollSurfaceToBottom(id: number): void;
  surfaceSize(id: number): GhosttySurfaceGrid;
  surfacePng(id: number): Buffer | undefined;
  surfaceText(id: number): string | undefined;
  destroySurface(id: number): void;
  surfaceCount(): number;
};

/// Loads the native addon, or returns undefined when unavailable (wrong
/// platform, addon not built, load failure). Never throws: an unhealthy
/// native layer downgrades to the xterm renderer.
export function loadGhosttyHostAddon(options: { addonPath: string; resourcesPath: string }): GhosttyHostAddon | undefined {
  if (process.platform !== "darwin") return undefined;
  process.env.GHOSTTY_RESOURCES_DIR = options.resourcesPath;
  try {
    return createRequire(import.meta.url)(options.addonPath) as GhosttyHostAddon;
  } catch { return undefined; }
}
