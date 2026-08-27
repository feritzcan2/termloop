import { describe, expect, it, vi } from "vitest";
import {
  DOUBLE_SHIFT_WINDOW_MS,
  DoubleShiftDetector,
  filterShellCommands,
  keyboardPlatform,
  matchesShellShortcut,
  nativeProjectShortcutIndex,
  nativeShellCommandId,
  projectShortcutIndex,
  projectShortcutLabel,
  PROJECT_SHORTCUT_LIMIT,
  shellShortcutsBlocked,
  shortcutLabel,
  showsWindowDragRegion,
  type KeyboardPlatform,
  type ShellCommand,
} from "../src/renderer/command-surface.js";

function key(
  platform: KeyboardPlatform,
  code: string,
  modifiers: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {},
) {
  return {
    code,
    altKey: false,
    ctrlKey: platform !== "mac",
    metaKey: platform === "mac",
    shiftKey: false,
    ...modifiers,
  };
}

describe("keyboard command surface", () => {
  it.each([
    ["mac" as const, "Mozilla/5.0 (Macintosh; Intel Mac OS X)", "⇧⌘P", "⌥⌘←"],
    ["windows" as const, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Ctrl+Shift+P", "Ctrl+Alt+←"],
    ["linux" as const, "Mozilla/5.0 (X11; Linux x86_64)", "Ctrl+Shift+P", "Ctrl+Alt+←"],
  ])("maps %s shortcuts without changing command semantics", (platform, userAgent, palette, previous) => {
    expect(keyboardPlatform(userAgent)).toBe(platform);
    expect(shortcutLabel("commandPalette", platform)).toBe(palette);
    expect(shortcutLabel("focusPreviousPane", platform)).toBe(previous);
    expect(matchesShellShortcut(key(platform, "KeyP", { shiftKey: true }), "commandPalette", platform)).toBe(true);
    expect(matchesShellShortcut(key(platform, "ArrowLeft", { altKey: true }), "focusPreviousPane", platform)).toBe(true);
  });

  it("reserves the window drag strip only where the native title bar is hidden", () => {
    expect(showsWindowDragRegion("mac")).toBe(true);
    expect(showsWindowDragRegion("windows")).toBe(false);
    expect(showsWindowDragRegion("linux")).toBe(false);
  });

  it("rejects partial and extra-modifier conflicts so terminal input is not captured", () => {
    expect(matchesShellShortcut(key("mac", "KeyT"), "newTerminal", "mac")).toBe(true);
    expect(matchesShellShortcut(key("mac", "KeyT", { shiftKey: true }), "newTerminal", "mac")).toBe(false);
    expect(matchesShellShortcut({ ...key("mac", "KeyT"), ctrlKey: true }, "newTerminal", "mac")).toBe(false);
    expect(matchesShellShortcut(key("windows", "KeyT", { altKey: true }), "newTerminal", "windows")).toBe(false);
    expect(matchesShellShortcut({ ...key("windows", "KeyT"), metaKey: true }, "newTerminal", "windows")).toBe(false);
  });

  it("selects Projects one through nine by ordinal like the legacy app", () => {
    expect(projectShortcutIndex(key("mac", "Digit1"), "mac")).toBe(0);
    expect(projectShortcutIndex(key("mac", "Digit9"), "mac")).toBe(8);
    expect(projectShortcutIndex(key("windows", "Digit3"), "windows")).toBe(2);
    expect(projectShortcutLabel(0, "mac")).toBe("⌘1");
    expect(projectShortcutLabel(8, "linux")).toBe("Ctrl+9");
    expect(projectShortcutLabel(PROJECT_SHORTCUT_LIMIT, "mac")).toBeUndefined();
    expect(nativeProjectShortcutIndex("project.1")).toBe(0);
    expect(nativeProjectShortcutIndex("project.9")).toBe(8);
    expect(nativeShellCommandId("project.1")).toBeUndefined();
    expect(nativeShellCommandId("newTerminal")).toBe("newTerminal");
  });

  it("leaves digit chords the legacy app did not own to the terminal", () => {
    expect(projectShortcutIndex(key("mac", "Digit0"), "mac")).toBeUndefined();
    expect(projectShortcutIndex(key("mac", "Digit1", { altKey: true }), "mac")).toBeUndefined();
    expect(projectShortcutIndex(key("mac", "Digit1", { shiftKey: true }), "mac")).toBeUndefined();
    expect(projectShortcutIndex({ ...key("mac", "Digit1"), ctrlKey: true }, "mac")).toBeUndefined();
    expect(projectShortcutIndex({ ...key("windows", "Digit1"), metaKey: true }, "windows")).toBeUndefined();
    expect(projectShortcutIndex({ ...key("mac", "Digit1"), metaKey: false }, "mac")).toBeUndefined();
  });

  it("keeps shell shortcuts available while the changes editor owns the stage", () => {
    expect(shellShortcutsBlocked({
      projectDialogOpen: false,
      projectMenuOpen: false,
      editProjectOpen: false,
      deleteProjectOpen: false,
      renameSessionOpen: false,
      shortcutSettingsOpen: false,
      quickActionOpen: false,
      runEditorOpen: false,
      changesEditorOpen: true,
    })).toBe(false);
    expect(shellShortcutsBlocked({
      projectDialogOpen: true,
      projectMenuOpen: false,
      editProjectOpen: false,
      deleteProjectOpen: false,
      renameSessionOpen: false,
      shortcutSettingsOpen: false,
      quickActionOpen: false,
      runEditorOpen: false,
      changesEditorOpen: true,
    })).toBe(true);
    expect(shellShortcutsBlocked({
      projectDialogOpen: false,
      projectMenuOpen: false,
      editProjectOpen: false,
      deleteProjectOpen: false,
      renameSessionOpen: false,
      shortcutSettingsOpen: true,
      quickActionOpen: false,
      runEditorOpen: false,
      changesEditorOpen: false,
    })).toBe(true);
  });

  it("detects Shift-release-Shift without consuming modifiers and resets on conflicts", () => {
    const detector = new DoubleShiftDetector(300);
    const down = (timeStamp: number, code = "ShiftLeft", overrides = {}) => detector.keyDown({
      code, timeStamp, shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, repeat: false, ...overrides,
    });
    expect(down(100)).toBe(false);
    detector.keyUp({ code: "ShiftLeft", timeStamp: 150 });
    expect(down(240, "ShiftRight")).toBe(true);
    expect(down(500)).toBe(false);
    detector.keyUp({ code: "ShiftLeft", timeStamp: 540 });
    expect(down(900)).toBe(false);
    expect(down(1_000, "KeyA")).toBe(false);
    expect(down(1_100)).toBe(false);
    detector.keyUp({ code: "ShiftLeft", timeStamp: 1_150 });
    expect(down(1_200, "ShiftLeft", { metaKey: true })).toBe(false);
  });

  it("accepts an unhurried double tap at the default window", () => {
    // A comfortable double tap runs past 300ms once the release is inside the
    // same budget, which is exactly what made Quick Action miss opens.
    expect(DOUBLE_SHIFT_WINDOW_MS).toBe(500);
    const detector = new DoubleShiftDetector();
    const down = (timeStamp: number) => detector.keyDown({
      code: "ShiftLeft", timeStamp, shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, repeat: false,
    });
    expect(down(0)).toBe(false);
    detector.keyUp({ code: "ShiftLeft", timeStamp: 180 });
    expect(down(430)).toBe(true);

    expect(down(1_000)).toBe(false);
    detector.keyUp({ code: "ShiftLeft", timeStamp: 1_180 });
    expect(down(1_600)).toBe(false);
  });

  it("searches named commands by title, detail, and keywords while preserving stable order", () => {
    const perform = vi.fn();
    const commands: ShellCommand[] = [
      { id: "terminal", title: "New Terminal", detail: "Selected Project", group: "Launch", keywords: ["shell"], perform },
      { id: "claude", title: "New Claude Session", detail: "Selected Project", group: "Launch", keywords: ["agent"], perform },
      { id: "switch", title: "Switch to Nucleus", detail: "/work/nucleus", group: "Project", perform },
    ];
    expect(filterShellCommands(commands, "new").map((command) => command.id)).toEqual(["terminal", "claude"]);
    expect(filterShellCommands(commands, "shell").map((command) => command.id)).toEqual(["terminal"]);
    expect(filterShellCommands(commands, "nucleus").map((command) => command.id)).toEqual(["switch"]);
    expect(filterShellCommands(commands, "missing")).toEqual([]);
  });
});
