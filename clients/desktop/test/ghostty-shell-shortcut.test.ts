import { describe, expect, it } from "vitest";
import { parseGhosttyShellShortcut, TERMLOOP_NATIVE_INPUT_POLICY } from "../src/ghostty-shell-shortcut.js";

describe("Ghostty shell shortcut boundary", () => {
  it("routes native Cmd+F through the allowlisted fork command", () => {
    const binding = TERMLOOP_NATIVE_INPUT_POLICY.bindings.find((item) => item.keyCode === 0x03 && item.modifiers === 8);
    expect(parseGhosttyShellShortcut(binding?.action)).toBe("forkSession");
  });

  it("routes native Cmd+Q and Cmd+W to the Agents and Tasks tabs", () => {
    const action = (keyCode: number) => TERMLOOP_NATIVE_INPUT_POLICY.bindings.find((item) => item.keyCode === keyCode && item.modifiers === 8)?.action;
    expect(parseGhosttyShellShortcut(action(0x0c))).toBe("agentsView");
    expect(parseGhosttyShellShortcut(action(0x0d))).toBe("tasksView");
    const command = (keyCode: number) => TERMLOOP_NATIVE_INPUT_POLICY.bindings.find((item) => item.keyCode === keyCode && item.modifiers === 8)?.action;
    expect(parseGhosttyShellShortcut(command(0x05))).toBe("sourceControl");
    expect(parseGhosttyShellShortcut(command(0x01))).toBe("steward");
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
