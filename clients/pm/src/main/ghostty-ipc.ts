// Main-side handlers for the native Ghostty surface channels. Electron-free
// so the channel set and argument validation are unit-testable; main.ts
// registers each entry behind the trusted-sender check.
import type { GhosttySurfaceManager } from "@termloop/ghostty-host";
import { IPC, type PmGhosttyFrame } from "../pm-api.js";

/** The slice of `GhosttySurfaceManager` the renderer may drive. */
export type GhosttySurfaces = Pick<GhosttySurfaceManager,
  "create" | "write" | "setFrame" | "setVisible" | "focus" | "scrollToBottom" | "paste" | "probeText" | "snapshotPng" | "snapshotAndHidePng" | "destroy">;

const MAX_PASTE_CHARS = 65_536;
const MAX_SNAPSHOT_TEXT_CHARS = 262_144;
const MAX_SNAPSHOT_PNG_BYTES = 32 * 1024 * 1024;

function surfaceId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("invalidGhosttySurfaceId");
  return value;
}

function frame(value: unknown): PmGhosttyFrame {
  if (typeof value !== "object" || value === null) throw new Error("invalidGhosttySurfaceFrame");
  const { x, y, width, height } = value as Record<string, unknown>;
  if (![x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part))
    || (width as number) < 0 || (height as number) < 0) throw new Error("invalidGhosttySurfaceFrame");
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

/** A creation frame is optional, but when given it must be a laid-out rect. */
function creationFrame(value: unknown): PmGhosttyFrame | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = frame(value);
  if (parsed.width === 0 || parsed.height === 0) throw new Error("invalidGhosttySurfaceFrame");
  return parsed;
}

function pngDataUrl(png: Buffer | undefined): string | undefined {
  if (!png || png.byteLength > MAX_SNAPSHOT_PNG_BYTES) return undefined;
  return `data:image/png;base64,${png.toString("base64")}`;
}

export type GhosttyHandler = (...args: unknown[]) => unknown;

/**
 * One handler per allowlisted channel. Each resolves the manager per call and
 * fails with `ghosttyUnavailable` when main runs the xterm renderer.
 */
export function ghosttyHandlers(manager: () => GhosttySurfaces | undefined): Record<string, GhosttyHandler> {
  const surfaces = (): GhosttySurfaces => {
    const current = manager();
    if (!current) throw new Error("ghosttyUnavailable");
    return current;
  };
  return {
    [IPC.ghosttyCreate]: (value) => surfaces().create(creationFrame(value)),
    [IPC.ghosttyWrite]: async (id, data) => {
      if (!(data instanceof Uint8Array)) throw new Error("invalidGhosttySurfaceData");
      await surfaces().write(surfaceId(id), data);
    },
    [IPC.ghosttySetFrame]: (id, value) => {
      const { x, y, width, height } = frame(value);
      return surfaces().setFrame(surfaceId(id), x, y, width, height);
    },
    [IPC.ghosttySetVisible]: (id, visible) => {
      if (typeof visible !== "boolean") throw new Error("invalidGhosttySurfaceVisibility");
      surfaces().setVisible(surfaceId(id), visible);
    },
    [IPC.ghosttyFocus]: (id) => surfaces().focus(surfaceId(id)),
    [IPC.ghosttyScrollBottom]: (id) => surfaces().scrollToBottom(surfaceId(id)),
    [IPC.ghosttyPaste]: (id, text) => {
      if (typeof text !== "string" || text.length === 0 || text.length > MAX_PASTE_CHARS) throw new Error("invalidGhosttySurfacePaste");
      surfaces().paste(surfaceId(id), text);
    },
    [IPC.ghosttySnapshotText]: (id) => surfaces().probeText(surfaceId(id))?.slice(0, MAX_SNAPSHOT_TEXT_CHARS),
    [IPC.ghosttySnapshotImage]: (id) => pngDataUrl(surfaces().snapshotPng(surfaceId(id))),
    [IPC.ghosttySnapshotAndHide]: (id) => pngDataUrl(surfaces().snapshotAndHidePng(surfaceId(id))),
    [IPC.ghosttyDestroy]: (id) => surfaces().destroy(surfaceId(id)),
  };
}
