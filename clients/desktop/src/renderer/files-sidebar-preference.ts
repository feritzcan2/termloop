/// Client-local presentation preference for the right-hand sidebar (Files or Source Control).
/// Core owns none of it; a blocked store only loses the remembered layout.
const FILES_SIDEBAR_KEY = "termloop.filesSidebar.v1";

export const FILES_SIDEBAR_MIN_WIDTH = 220;
export const FILES_SIDEBAR_MAX_WIDTH = 640;
export const FILES_SIDEBAR_DEFAULT_WIDTH = 300;
/// Mirrors `--files-activity-width` in files.css.
export const FILES_ACTIVITY_BAR_WIDTH = 40;
const WORKSPACE_MIN_WIDTH = 360;

export type RightSidebarView = "files" | "sourceControl";
export type FilesSidebarPreference = { open: boolean; view: RightSidebarView; width: number };

const DEFAULT: FilesSidebarPreference = { open: false, view: "files", width: FILES_SIDEBAR_DEFAULT_WIDTH };

export function filesSidebarMaximumWidth(viewportWidth: number, leftSidebarWidth: number): number {
  return Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(FILES_SIDEBAR_MAX_WIDTH, viewportWidth - leftSidebarWidth - FILES_ACTIVITY_BAR_WIDTH - WORKSPACE_MIN_WIDTH));
}

export function clampFilesSidebarWidth(width: number, viewportWidth: number, leftSidebarWidth: number): number {
  return Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(filesSidebarMaximumWidth(viewportWidth, leftSidebarWidth), Math.round(width)));
}

export function readFilesSidebarPreference(storage?: Pick<Storage, "getItem">): FilesSidebarPreference {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const parsed = JSON.parse(source?.getItem(FILES_SIDEBAR_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT;
    const { open, view, width } = parsed as Record<string, unknown>;
    return {
      open: open === true,
      view: view === "sourceControl" ? "sourceControl" : "files",
      width: typeof width === "number" && Number.isFinite(width) ? Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(FILES_SIDEBAR_MAX_WIDTH, Math.round(width))) : DEFAULT.width,
    };
  } catch {
    return DEFAULT;
  }
}

export function writeFilesSidebarPreference(preference: FilesSidebarPreference, storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(FILES_SIDEBAR_KEY, JSON.stringify(preference));
  } catch {
    // An unavailable preference store must not prevent in-session use.
  }
}
