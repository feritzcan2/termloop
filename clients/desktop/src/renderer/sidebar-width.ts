export const SIDEBAR_MIN_WIDTH = 190;
export const SIDEBAR_MAX_WIDTH = 480;
const WORKSPACE_MIN_WIDTH = 360;
const SIDEBAR_WIDTH_KEY = "termloop.sidebarWidth.v1";

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;
type RemoveStorage = Pick<Storage, "removeItem">;

export function sidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - WORKSPACE_MIN_WIDTH));
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarMaximumWidth(viewportWidth), Math.round(width)));
}

export function readSidebarWidth(viewportWidth: number, storage?: ReadStorage): number {
  const maximum = sidebarMaximumWidth(viewportWidth);
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const stored = source?.getItem(SIDEBAR_WIDTH_KEY);
    if (stored === undefined || stored === null || stored.trim().length === 0) return maximum;
    const width = Number(stored);
    return Number.isFinite(width) ? clampSidebarWidth(width, viewportWidth) : maximum;
  } catch {
    return maximum;
  }
}

export function writeSidebarWidth(width: number, storage?: WriteStorage): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // An unavailable preference store must not prevent in-session resizing.
  }
}

export function clearSidebarWidth(storage?: RemoveStorage): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.removeItem(SIDEBAR_WIDTH_KEY);
  } catch {
    // Reset still applies for this session when preference storage is unavailable.
  }
}
