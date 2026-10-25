// Native Ghostty renderer selection and addon loading. Mirrors the desktop
// app: Ghostty is the macOS default, TERMLOOP_TERMINAL_RENDERER=xterm is the
// kill switch, and a missing or unloadable addon falls back to xterm.
import path from "node:path";
import { loadGhosttyHostAddon as loadAddon, type GhosttyHostAddon } from "@termloop/ghostty-host";
import type { PmTerminalRenderer } from "../pm-api.js";

export function terminalRendererFor(platform: NodeJS.Platform, requested: string | undefined): PmTerminalRenderer {
  return platform === "darwin" && requested !== "xterm" ? "ghostty" : "xterm";
}

export function requestedTerminalRenderer(): PmTerminalRenderer {
  return terminalRendererFor(process.platform, process.env.TERMLOOP_TERMINAL_RENDERER);
}

/**
 * In a checkout the addon is `@termloop/ghostty-host`'s built copy (the same
 * file desktop stages, with `libghostty.dylib` beside it) and the resources
 * are the vendored Ghostty share directory desktop also uses.
 */
export function ghosttyHostPaths(appPath: string, packaged: boolean, resourcesPath: string, env: NodeJS.ProcessEnv): { addonPath: string; resourcesPath: string } {
  return {
    addonPath: env.TERMLOOP_GHOSTTY_ADDON
      ?? (packaged
        ? path.join(resourcesPath, "native", "ghostty-host", "ghostty_host.node")
        : path.join(appPath, "..", "ghostty-host", "dist", "native", "ghostty_host.node")),
    resourcesPath: env.GHOSTTY_RESOURCES_DIR ?? env.TERMLOOP_GHOSTTY_RESOURCES
      ?? (packaged
        ? path.join(resourcesPath, "ghostty")
        : path.join(appPath, "..", "..", "vendor", "ghostty", "zig-out", "share", "ghostty")),
  };
}

/** Never throws: undefined means the window runs the xterm renderer. */
export function loadGhosttyHostAddon(appPath: string, packaged: boolean): GhosttyHostAddon | undefined {
  if (requestedTerminalRenderer() !== "ghostty") return undefined;
  return loadAddon(ghosttyHostPaths(appPath, packaged, process.resourcesPath, process.env));
}
