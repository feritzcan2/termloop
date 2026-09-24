export type GhosttyShellShortcut =
  | "pasteImage"
  | "quickAction"
  | "commandPalette"
  | "newTerminal"
  | "renameSession"
  | "focusPreviousPane"
  | "focusNextPane"
  | "project.1"
  | "project.2"
  | "project.3"
  | "project.4"
  | "project.5"
  | "project.6"
  | "project.7"
  | "project.8"
  | "project.9";

const GHOSTTY_SHELL_SHORTCUTS: ReadonlySet<string> = new Set([
  "pasteImage",
  "quickAction",
  "commandPalette",
  "newTerminal",
  "renameSession",
  "focusPreviousPane",
  "focusNextPane",
  ...Array.from({ length: 9 }, (_, index) => `project.${index + 1}`),
]);

export function parseGhosttyShellShortcut(value: unknown): GhosttyShellShortcut | undefined {
  return typeof value === "string" && GHOSTTY_SHELL_SHORTCUTS.has(value)
    ? value as GhosttyShellShortcut
    : undefined;
}

// Product policy. Native surfaces and the renderer use the same double-tap budget.
export const DOUBLE_SHIFT_WINDOW_MS = 500;
export const TERMLOOP_NATIVE_INPUT_POLICY = {
  bindings: [
    { keyCode: 0x23, modifiers: 9, action: "commandPalette" },
    { keyCode: 0x11, modifiers: 8, action: "newTerminal" },
    { keyCode: 0x0f, modifiers: 8, action: "renameSession" },
    { keyCode: 0x7b, modifiers: 12, action: "focusPreviousPane" },
    { keyCode: 0x7c, modifiers: 12, action: "focusNextPane" },
    ...[0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1a, 0x1c, 0x19].map((keyCode, index) => ({
      keyCode, modifiers: 8, action: `project.${index + 1}`,
    })),
  ],
  imagePasteAction: "pasteImage",
  doubleShiftAction: "quickAction",
  doubleShiftWindowMs: DOUBLE_SHIFT_WINDOW_MS,
};
