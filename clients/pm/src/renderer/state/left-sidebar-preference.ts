// Renderer-local layout preference for the left sidebar width, stored beside
// the right sidebar's, plus the clamp that keeps both sidebars from squeezing
// the stage below a usable width on a narrow window.
import {
  RIGHT_SIDEBAR_MIN_WIDTH,
  defaultStorage,
  type PreferenceSource,
  type PreferenceTarget,
} from "./right-sidebar-preference.js";

const KEY = "termloop.pm.leftSidebar.v1";

export const LEFT_SIDEBAR_MIN_WIDTH = 240;
export const LEFT_SIDEBAR_MAX_WIDTH = 520;
export const LEFT_SIDEBAR_DEFAULT_WIDTH = 340;
/** The narrowest the stage gets before the sidebars give way. */
export const STAGE_MIN_WIDTH = 420;
/** The right activity bar (`--activity-width`). */
export const ACTIVITY_BAR_WIDTH = 44;

export type LeftSidebarPreference = { width: number };

export const DEFAULT_LEFT_SIDEBAR: LeftSidebarPreference = { width: LEFT_SIDEBAR_DEFAULT_WIDTH };

export function clampLeftSidebarWidth(width: number): number {
  return Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.round(width)));
}

export function readLeftSidebarPreference(storage?: PreferenceSource): LeftSidebarPreference {
  try {
    const parsed = JSON.parse((storage ?? defaultStorage())?.getItem(KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_LEFT_SIDEBAR;
    const { width } = parsed as Record<string, unknown>;
    return { width: typeof width === "number" && Number.isFinite(width) ? clampLeftSidebarWidth(width) : LEFT_SIDEBAR_DEFAULT_WIDTH };
  } catch {
    return DEFAULT_LEFT_SIDEBAR;
  }
}

export function writeLeftSidebarPreference(preference: LeftSidebarPreference, storage?: PreferenceTarget): void {
  try {
    (storage ?? defaultStorage())?.setItem(KEY, JSON.stringify(preference));
  } catch {
    // An unavailable store must not prevent in-session use.
  }
}

/**
 * The widths actually laid out for a window `viewport` px wide. The stage
 * keeps `STAGE_MIN_WIDTH`; the right panel (when open) gives way first, then
 * the left sidebar, neither below its minimum. The stored preferences are
 * untouched, so widening the window restores them.
 */
export function fitSidebarWidths(left: number, right: number | undefined, viewport: number): { left: number; right: number | undefined } {
  let excess = left + (right ?? 0) + ACTIVITY_BAR_WIDTH + STAGE_MIN_WIDTH - viewport;
  let fittedRight = right;
  if (excess > 0 && right !== undefined) {
    fittedRight = Math.max(RIGHT_SIDEBAR_MIN_WIDTH, right - excess);
    excess -= right - fittedRight;
  }
  const fittedLeft = excess > 0 ? Math.max(LEFT_SIDEBAR_MIN_WIDTH, left - excess) : left;
  return { left: fittedLeft, right: fittedRight };
}
