import { describe, expect, it } from "vitest";
import { nativeShortcutMessage, PM_NATIVE_INPUT_POLICY } from "../src/main/ghostty-ipc.js";
import {
  DEFAULT_LEFT_SIDEBAR,
  clampLeftSidebarWidth,
  fitSidebarWidths,
  readLeftSidebarPreference,
  writeLeftSidebarPreference,
} from "../src/renderer/state/left-sidebar-preference.js";
import { clampRightSidebarWidth } from "../src/renderer/state/right-sidebar-preference.js";
import { DOUBLE_SHIFT_WINDOW_MS } from "../src/pm-api.js";

describe("left sidebar preference", () => {
  it("defaults to 340px and clamps to 240-520", () => {
    expect(DEFAULT_LEFT_SIDEBAR.width).toBe(340);
    expect(clampLeftSidebarWidth(100)).toBe(240);
    expect(clampLeftSidebarWidth(900)).toBe(520);
    expect(clampRightSidebarWidth(900)).toBe(640);
    expect(clampRightSidebarWidth(100)).toBe(280);
  });

  it("round-trips under its own key and falls back on bad or blocked storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    writeLeftSidebarPreference({ width: 400 }, storage);
    expect([...store.keys()]).toEqual(["termloop.pm.leftSidebar.v1"]);
    expect(readLeftSidebarPreference(storage)).toEqual({ width: 400 });
    store.set("termloop.pm.leftSidebar.v1", JSON.stringify({ width: 9999 }));
    expect(readLeftSidebarPreference(storage)).toEqual({ width: 520 });
    store.set("termloop.pm.leftSidebar.v1", "{oops");
    expect(readLeftSidebarPreference(storage)).toEqual(DEFAULT_LEFT_SIDEBAR);
    const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readLeftSidebarPreference(blocked)).toEqual(DEFAULT_LEFT_SIDEBAR);
    expect(() => writeLeftSidebarPreference({ width: 300 }, blocked)).not.toThrow();
  });
});

describe("sidebar fit", () => {
  it("leaves the preferences alone when the stage keeps its minimum", () => {
    expect(fitSidebarWidths(340, 320, 1280)).toEqual({ left: 340, right: 320 });
    expect(fitSidebarWidths(520, undefined, 1280)).toEqual({ left: 520, right: undefined });
  });

  it("shrinks the right panel first, then the left, never below their minimums", () => {
    // 1280 - 44 activity - 420 stage = 816 for both sidebars.
    expect(fitSidebarWidths(400, 640, 1280)).toEqual({ left: 400, right: 416 });
    expect(fitSidebarWidths(520, 640, 1280)).toEqual({ left: 520, right: 296 });
    expect(fitSidebarWidths(520, 640, 1100)).toEqual({ left: 356, right: 280 });
    expect(fitSidebarWidths(520, 640, 600)).toEqual({ left: 240, right: 280 });
    const fitted = fitSidebarWidths(520, 640, 1280);
    expect(fitted.left + fitted.right! + 44 + 420).toBeLessThanOrEqual(1280);
  });
});

describe("native quick capture shortcut", () => {
  it("binds double Shift and Cmd+N in the native host and forwards only allowlisted shortcuts", () => {
    expect(PM_NATIVE_INPUT_POLICY).toMatchObject({ doubleShiftAction: "quickCapture", doubleShiftWindowMs: DOUBLE_SHIFT_WINDOW_MS });
    expect(PM_NATIVE_INPUT_POLICY.bindings).toEqual([{ keyCode: 0x2d, modifiers: 8, action: "quickCapture" }]);
    expect(nativeShortcutMessage("quickCapture")).toEqual({ shortcut: "quickCapture" });
    expect(nativeShortcutMessage("commandPalette")).toBeUndefined();
    expect(nativeShortcutMessage({ shortcut: "quickCapture" })).toBeUndefined();
  });
});
