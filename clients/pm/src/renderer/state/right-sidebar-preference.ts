// Renderer-local layout preference for the right sidebar: which view the
// activity bar has open and the panel width. The daemon owns none of it; a
// blocked store only loses the remembered layout.
import type { RightSidebarView } from "../ui/types.js";

export type { RightSidebarView } from "../ui/types.js";

const KEY = "termloop.pm.rightSidebar.v2";

export const RIGHT_SIDEBAR_MIN_WIDTH = 280;
export const RIGHT_SIDEBAR_MAX_WIDTH = 640;
export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 380;

const RIGHT_SIDEBAR_VIEWS: readonly RightSidebarView[] = ["steward", "suggestions"];
export type RightSidebarPreference = { open: boolean; view: RightSidebarView; width: number };

export const DEFAULT_RIGHT_SIDEBAR: RightSidebarPreference = { open: true, view: "steward", width: RIGHT_SIDEBAR_DEFAULT_WIDTH };

export function clampRightSidebarWidth(width: number): number {
  return Math.max(RIGHT_SIDEBAR_MIN_WIDTH, Math.min(RIGHT_SIDEBAR_MAX_WIDTH, Math.round(width)));
}

/** Activity bar semantics: choosing the open view closes the panel; any other choice opens that view. */
export function toggleRightSidebar(preference: RightSidebarPreference, view: RightSidebarView): RightSidebarPreference {
  const closing = preference.open && preference.view === view;
  return { ...preference, open: !closing, view };
}

export type PreferenceSource = Pick<Storage, "getItem"> | undefined;
export type PreferenceTarget = Pick<Storage, "setItem"> | undefined;

export function defaultStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function readRightSidebarPreference(storage?: PreferenceSource): RightSidebarPreference {
  try {
    const parsed = JSON.parse((storage ?? defaultStorage())?.getItem(KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_RIGHT_SIDEBAR;
    const { open, view, width } = parsed as Record<string, unknown>;
    return {
      open: typeof open === "boolean" ? open : DEFAULT_RIGHT_SIDEBAR.open,
      view: RIGHT_SIDEBAR_VIEWS.find((candidate) => candidate === view) ?? DEFAULT_RIGHT_SIDEBAR.view,
      width: typeof width === "number" && Number.isFinite(width) ? clampRightSidebarWidth(width) : DEFAULT_RIGHT_SIDEBAR.width,
    };
  } catch {
    return DEFAULT_RIGHT_SIDEBAR;
  }
}

export function writeRightSidebarPreference(preference: RightSidebarPreference, storage?: PreferenceTarget): void {
  try {
    (storage ?? defaultStorage())?.setItem(KEY, JSON.stringify(preference));
  } catch {
    // An unavailable store must not prevent in-session use.
  }
}
