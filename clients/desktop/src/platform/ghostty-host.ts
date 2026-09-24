import { loadGhosttyHostAddon as loadAddon } from "@termloop/ghostty-host";
export type { GhosttyHostAddon, GhosttySurfaceGrid } from "@termloop/ghostty-host";
import path from "node:path";
import type { GhosttyHostAddon } from "@termloop/ghostty-host";

export function loadGhosttyHostAddon(appPath: string): GhosttyHostAddon | undefined {
  if (process.platform !== "darwin") return undefined;
  const packaged = path.basename(appPath) === "app.asar";
  const addonPath = process.env.TERMLOOP_GHOSTTY_ADDON
    ?? (packaged
      ? path.join(process.resourcesPath, "native", "ghostty-host", "ghostty_host.node")
      : path.join(appPath, "native", "ghostty-host", "build", "Release", "ghostty_host.node"));
  // Ghostty needs its resources (terminfo, themes) before app init.
  const resourcesPath = process.env.GHOSTTY_RESOURCES_DIR ?? process.env.TERMLOOP_GHOSTTY_RESOURCES
    ?? (packaged
      ? path.join(process.resourcesPath, "ghostty")
      : path.join(appPath, "..", "..", "vendor", "ghostty", "zig-out", "share", "ghostty"));
  return loadAddon({ addonPath, resourcesPath });
}
