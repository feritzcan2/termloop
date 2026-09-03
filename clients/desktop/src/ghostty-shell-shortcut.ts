export type GhosttyShellShortcut =
  | "pasteImage"
  | "quickAction"
  | "commandPalette"
  | "newTerminal"
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
  "focusPreviousPane",
  "focusNextPane",
  ...Array.from({ length: 9 }, (_, index) => `project.${index + 1}`),
]);

export function parseGhosttyShellShortcut(value: unknown): GhosttyShellShortcut | undefined {
  return typeof value === "string" && GHOSTTY_SHELL_SHORTCUTS.has(value)
    ? value as GhosttyShellShortcut
    : undefined;
}
