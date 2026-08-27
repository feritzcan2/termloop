import type { GhosttyShellShortcut } from "../ghostty-shell-shortcut.js";

export type KeyboardPlatform = "mac" | "windows" | "linux";

export type ShellShortcutId =
  | "commandPalette"
  | "newTerminal"
  | "focusPreviousPane"
  | "focusNextPane";

export type ShellCommandGroup = "Project" | "Launch" | "Session" | "Layout" | "Settings";

export type ShellCommand = {
  id: string;
  title: string;
  detail: string;
  group: ShellCommandGroup;
  keywords?: readonly string[];
  shortcutId?: ShellShortcutId;
  shortcutHint?: string;
  disabled?: boolean;
  danger?: boolean;
  perform(): void | Promise<void>;
};

export type ShellSurfaceState = {
  projectDialogOpen: boolean;
  projectMenuOpen: boolean;
  editProjectOpen: boolean;
  deleteProjectOpen: boolean;
  renameSessionOpen: boolean;
  shortcutSettingsOpen: boolean;
  quickActionOpen: boolean;
  runEditorOpen: boolean;
  changesEditorOpen: boolean;
};

// The changes editor replaces only the terminal stage and deliberately leaves
// Project and Session navigation available. True dialogs and the Quick Action
// composer still block shell shortcuts while they own keyboard focus.
export function shellShortcutsBlocked(state: ShellSurfaceState): boolean {
  return state.projectDialogOpen
    || state.projectMenuOpen
    || state.editProjectOpen
    || state.deleteProjectOpen
    || state.renameSessionOpen
    || state.shortcutSettingsOpen
    || state.quickActionOpen
    || state.runEditorOpen;
}

type KeyboardEventShape = Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey">;

type Shortcut = {
  code: string;
  alt?: boolean;
  shift?: boolean;
};

const SHORTCUTS: Record<ShellShortcutId, Shortcut> = {
  commandPalette: { code: "KeyP", shift: true },
  newTerminal: { code: "KeyT" },
  focusPreviousPane: { code: "ArrowLeft", alt: true },
  focusNextPane: { code: "ArrowRight", alt: true },
};

export function keyboardPlatform(userAgent: string): KeyboardPlatform {
  if (/macintosh|mac os x/iu.test(userAgent)) return "mac";
  if (/windows/iu.test(userAgent)) return "windows";
  return "linux";
}

// Only macOS hides the native title bar (hiddenInset), so only there does the
// sidebar reserve a drag strip beside the inset traffic lights. Windows and
// Linux keep the native frame; the strip would be dead space under it.
export function showsWindowDragRegion(platform: KeyboardPlatform): boolean {
  return platform === "mac";
}

export function shortcutLabel(id: ShellShortcutId, platform: KeyboardPlatform): string {
  const shortcut = SHORTCUTS[id];
  const key = shortcut.code === "KeyP" ? "P"
    : shortcut.code === "KeyT" ? "T"
      : shortcut.code === "ArrowLeft" ? "←"
        : "→";
  if (platform === "mac") {
    return `${shortcut.alt ? "⌥" : ""}${shortcut.shift ? "⇧" : ""}⌘${key}`;
  }
  return `Ctrl+${shortcut.alt ? "Alt+" : ""}${shortcut.shift ? "Shift+" : ""}${key}`;
}

export function matchesShellShortcut(
  event: KeyboardEventShape,
  id: ShellShortcutId,
  platform: KeyboardPlatform,
): boolean {
  const shortcut = SHORTCUTS[id];
  const primary = platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return primary
    && event.code === shortcut.code
    && event.altKey === Boolean(shortcut.alt)
    && event.shiftKey === Boolean(shortcut.shift);
}

// The legacy app bound Cmd+1…Cmd+9 to "Select Project 1…9". Digits are a family
// rather than one named chord, so they match separately from SHORTCUTS.
export const PROJECT_SHORTCUT_LIMIT = 9;

export function projectShortcutIndex(
  event: KeyboardEventShape,
  platform: KeyboardPlatform,
): number | undefined {
  const primary = platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.altKey || event.shiftKey) return undefined;
  const digit = /^Digit([1-9])$/u.exec(event.code);
  return digit ? Number(digit[1]) - 1 : undefined;
}

export function projectShortcutLabel(index: number, platform: KeyboardPlatform): string | undefined {
  if (index < 0 || index >= PROJECT_SHORTCUT_LIMIT) return undefined;
  return platform === "mac" ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

export function nativeProjectShortcutIndex(shortcut: GhosttyShellShortcut): number | undefined {
  const match = /^project\.([1-9])$/u.exec(shortcut);
  return match ? Number(match[1]) - 1 : undefined;
}

export function nativeShellCommandId(shortcut: GhosttyShellShortcut): ShellShortcutId | undefined {
  return shortcut === "commandPalette"
    || shortcut === "newTerminal"
    || shortcut === "focusPreviousPane"
    || shortcut === "focusNextPane"
    ? shortcut
    : undefined;
}

export function filterShellCommands(commands: readonly ShellCommand[], query: string): ShellCommand[] {
  const terms = normalizedTerms(query);
  if (terms.length === 0) return [...commands];
  return commands
    .map((command, index) => ({ command, index, score: commandScore(command, terms) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((candidate) => candidate.command);
}

function commandScore(command: ShellCommand, terms: readonly string[]): number {
  const title = normalize(command.title);
  const detail = normalize(command.detail);
  const keywords = normalize(command.keywords?.join(" ") ?? "");
  let score = 0;
  for (const term of terms) {
    if (title === term) score += 100;
    else if (title.startsWith(term)) score += 60;
    else if (title.includes(term)) score += 35;
    else if (keywords.includes(term)) score += 20;
    else if (detail.includes(term)) score += 10;
    else return -1;
  }
  return score;
}

function normalizedTerms(value: string): string[] {
  return normalize(value).split(/\s+/u).filter(Boolean);
}

function normalize(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase().replace(/[\u0300-\u036f]/gu, "").trim();
}

// The window covers the whole Shift-release-Shift cycle, not just the gap
// between taps, so it has to be at least as generous as the platform
// double-click interval; 300ms rejected ordinary double taps. Keep this equal
// to the native Ghostty host's own detector in
// native/ghostty-host/src/ghostty_host.mm, which sees the keys instead
// whenever a native terminal surface holds focus.
export const DOUBLE_SHIFT_WINDOW_MS = 500;

export class DoubleShiftDetector {
  private firstDownAt: number | undefined;
  private released = false;

  constructor(private readonly windowMs = DOUBLE_SHIFT_WINDOW_MS) {}

  keyDown(event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "repeat" | "shiftKey" | "timeStamp">): boolean {
    if (!isShiftCode(event.code) || event.altKey || event.ctrlKey || event.metaKey || event.repeat) {
      this.reset();
      return false;
    }
    if (this.firstDownAt !== undefined && this.released && event.timeStamp - this.firstDownAt <= this.windowMs) {
      this.reset();
      return true;
    }
    this.firstDownAt = event.timeStamp;
    this.released = false;
    return false;
  }

  keyUp(event: Pick<KeyboardEvent, "code" | "timeStamp">): void {
    if (!isShiftCode(event.code) || this.firstDownAt === undefined) return;
    if (event.timeStamp - this.firstDownAt > this.windowMs) this.reset();
    else this.released = true;
  }

  reset(): void {
    this.firstDownAt = undefined;
    this.released = false;
  }
}

function isShiftCode(code: string): boolean {
  return code === "ShiftLeft" || code === "ShiftRight";
}
