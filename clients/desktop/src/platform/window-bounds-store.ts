import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_DOCUMENT_BYTES = 4 * 1024;
// A restored window must keep at least this much of itself on a display so
// its title bar stays reachable after a monitor is unplugged or rearranged.
const MIN_VISIBLE_EDGE = 100;

export type Rectangle = { x: number; y: number; width: number; height: number };

export type WindowBoundsState = {
  bounds: Rectangle;
  maximized: boolean;
  fullScreen: boolean;
};

type WindowBoundsDocument = { version: 1; window: WindowBoundsState };

export type WindowSizeLimits = { minWidth: number; minHeight: number };

export function windowBoundsStateOf(value: unknown): WindowBoundsState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<WindowBoundsState>;
  const bounds = rectangleOf(candidate.bounds);
  if (!bounds) return undefined;
  return {
    bounds,
    maximized: candidate.maximized === true,
    fullScreen: candidate.fullScreen === true,
  };
}

// Fits saved bounds onto the current displays. Bounds that still overlap a
// work area keep their position (clamped inside it); otherwise only the size
// survives and Electron centers the window on the primary display.
export function restorableWindowBounds(
  saved: Rectangle,
  workAreas: readonly Rectangle[],
  limits: WindowSizeLimits,
): Partial<Rectangle> & { width: number; height: number } {
  const visibleArea = workAreas.find((area) => visibleOverlap(saved, area));
  const target = visibleArea ?? workAreas[0];
  if (!target) return { width: Math.max(saved.width, limits.minWidth), height: Math.max(saved.height, limits.minHeight) };
  const width = clamp(saved.width, limits.minWidth, target.width);
  const height = clamp(saved.height, limits.minHeight, target.height);
  if (!visibleArea) return { width, height };
  return {
    x: clamp(saved.x, target.x, target.x + target.width - width),
    y: clamp(saved.y, target.y, target.y + target.height - height),
    width,
    height,
  };
}

export class WindowBoundsFileStore {
  constructor(private readonly filePath: string) {}

  load(): WindowBoundsState | undefined {
    try {
      const source = readFileSync(this.filePath, "utf8");
      if (Buffer.byteLength(source) > MAX_DOCUMENT_BYTES) return undefined;
      const document = JSON.parse(source) as Partial<WindowBoundsDocument>;
      if (document.version !== 1) return undefined;
      return windowBoundsStateOf(document.window);
    } catch {
      return undefined;
    }
  }

  // Synchronous on purpose: it runs from the window "close" handler during
  // quit, where a pending asynchronous write could be cut off.
  save(value: WindowBoundsState): void {
    const window = windowBoundsStateOf(value);
    if (!window) return;
    const source = `${JSON.stringify({ version: 1, window }, null, 2)}\n`;
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(temporary, source, { mode: 0o600 });
    if (process.platform === "win32") rmSync(this.filePath, { force: true });
    renameSync(temporary, this.filePath);
  }
}

function rectangleOf(value: unknown): Rectangle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (![x, y, width, height].every((entry) => typeof entry === "number" && Number.isFinite(entry))) return undefined;
  if ((width as number) <= 0 || (height as number) <= 0) return undefined;
  return {
    x: Math.round(x as number),
    y: Math.round(y as number),
    width: Math.round(width as number),
    height: Math.round(height as number),
  };
}

function visibleOverlap(window: Rectangle, area: Rectangle): boolean {
  const horizontal = Math.min(window.x + window.width, area.x + area.width) - Math.max(window.x, area.x);
  const vertical = Math.min(window.y + window.height, area.y + area.height) - Math.max(window.y, area.y);
  return horizontal >= MIN_VISIBLE_EDGE && vertical >= MIN_VISIBLE_EDGE;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
