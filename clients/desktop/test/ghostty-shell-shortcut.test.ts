import { describe, expect, it } from "vitest";
import { parseGhosttyShellShortcut, TERMLOOP_NATIVE_INPUT_POLICY } from "../src/ghostty-shell-shortcut.js";

describe("Ghostty shell shortcut boundary", () => {
  it("routes native Cmd+F through the allowlisted fork command", () => {
    const binding = TERMLOOP_NATIVE_INPUT_POLICY.bindings.find((item) => item.keyCode === 0x03 && item.modifiers === 8);
    expect(parseGhosttyShellShortcut(binding?.action)).toBe("forkSession");
  });

  it.each([
    "pasteImage",
    "quickAction",
    "commandPalette",
    "newTerminal",
    "renameSession",
    "forkSession",
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
