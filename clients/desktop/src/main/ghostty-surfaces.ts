import type { BrowserWindow } from "electron";
import { GhosttySurfaceManager as NativeSurfaceManager, type GhosttyHostAddon } from "@termloop/ghostty-host";
export { GhosttyConsumedWriteLedger, type SurfaceFrame } from "@termloop/ghostty-host";

import { TERMLOOP_NATIVE_INPUT_POLICY } from "../ghostty-shell-shortcut.js";

export class GhosttySurfaceManager extends NativeSurfaceManager {
  constructor(addon: GhosttyHostAddon, window: BrowserWindow, configFile: string, lightConfigFile: string) {
    super(addon, window, configFile, lightConfigFile, {
      input: (surfaceId, data) => window.webContents.send("termloop:ghostty-input", { surfaceId, data }),
      closed: (surfaceId) => window.webContents.send("termloop:ghostty-closed", { surfaceId }),
      shortcut: (shortcut) => window.webContents.send("termloop:ghostty-shell-shortcut", { shortcut }),
    }, TERMLOOP_NATIVE_INPUT_POLICY);
  }
}
