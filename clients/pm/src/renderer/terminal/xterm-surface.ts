// The xterm surface the PM mounts agents into; kept apart from the adapter so
// the adapter stays testable without a canvas.
import { XtermSurface } from "@termloop/terminal-surface/xterm";
import type { SurfaceFactory } from "./agent-terminal.js";

export const xtermSurface: SurfaceFactory = (onInput, onResize) => new XtermSurface(onInput, onResize, () => undefined);
