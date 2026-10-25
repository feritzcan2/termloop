// The surface factory the PM mounts agents into; kept apart from the adapter
// so the adapter stays testable without a canvas.
import { XtermSurface } from "@termloop/terminal-surface/xterm";
import type { SurfaceFactory } from "./agent-terminal.js";
import { selectSurfaceFactory } from "./surface-factory.js";

const xterm: SurfaceFactory = (onInput, onResize) => new XtermSurface(onInput, onResize, () => undefined);

/** Native Ghostty on macOS when available; xterm.js otherwise. */
export const agentSurface = selectSurfaceFactory(typeof window === "undefined" ? undefined : window.pm, xterm);
