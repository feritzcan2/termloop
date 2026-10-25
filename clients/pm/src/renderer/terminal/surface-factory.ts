// Picks the agent terminal renderer from the flag main gave the preload:
// the native Ghostty surface when main loaded its addon, xterm otherwise.
import type { PmApi } from "../../pm-api.js";
import type { SurfaceFactory } from "./agent-terminal.js";
import { createGhosttyBridge } from "./ghostty-bridge.js";
import { ghosttySurface } from "./ghostty-surface.js";

export function selectSurfaceFactory(pm: Pick<PmApi, "terminalRenderer" | "ghostty"> | undefined, xterm: SurfaceFactory): SurfaceFactory {
  return pm?.terminalRenderer === "ghostty" ? ghosttySurface(createGhosttyBridge(pm.ghostty)) : xterm;
}
