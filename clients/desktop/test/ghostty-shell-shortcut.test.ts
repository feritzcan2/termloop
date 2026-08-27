import { describe, expect, it } from "vitest";
import { parseGhosttyShellShortcut } from "../src/ghostty-shell-shortcut.js";

describe("Ghostty shell shortcut boundary", () => {
  it.each([
    "quickAction",
    "commandPalette",
    "newTerminal",
    "focusPreviousPane",
    "focusNextPane",
    "project.1",
    "project.9",
  ])("accepts the allowlisted shortcut %s", (shortcut) => {
    expect(parseGhosttyShellShortcut(shortcut)).toBe(shortcut);
  });

  it.each([
    "project.0",
    "project.10",
    "closeWindow",
    "quitApplication",
    "paste",
    "",
    undefined,
    { shortcut: "newTerminal" },
  ])("rejects an unowned native shortcut", (shortcut) => {
    expect(parseGhosttyShellShortcut(shortcut)).toBeUndefined();
  });
});
