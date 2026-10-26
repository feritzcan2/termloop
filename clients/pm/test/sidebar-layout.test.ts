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
  it("defaults to a 232px navigation column and clamps to 200-360", () => {
    expect(DEFAULT_LEFT_SIDEBAR.width).toBe(232);
    expect(clampLeftSidebarWidth(100)).toBe(200);
    expect(clampLeftSidebarWidth(900)).toBe(360);
    expect(clampRightSidebarWidth(900)).toBe(640);
    expect(clampRightSidebarWidth(100)).toBe(280);
  });

  it("round-trips under its own key and falls back on bad or blocked storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    writeLeftSidebarPreference({ width: 300 }, storage);
    expect([...store.keys()]).toEqual(["termloop.pm.leftSidebar.v2"]);
    expect(readLeftSidebarPreference(storage)).toEqual({ width: 300 });
    store.set("termloop.pm.leftSidebar.v2", JSON.stringify({ width: 9999 }));
    expect(readLeftSidebarPreference(storage)).toEqual({ width: 360 });
    store.set("termloop.pm.leftSidebar.v2", "{oops");
    expect(readLeftSidebarPreference(storage)).toEqual(DEFAULT_LEFT_SIDEBAR);
    const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readLeftSidebarPreference(blocked)).toEqual(DEFAULT_LEFT_SIDEBAR);
    expect(() => writeLeftSidebarPreference({ width: 300 }, blocked)).not.toThrow();
  });
});

describe("sidebar fit", () => {
  it("leaves the preferences alone when the stage keeps its minimum", () => {
    expect(fitSidebarWidths(232, 380, 1280)).toEqual({ left: 232, right: 380 });
    expect(fitSidebarWidths(360, undefined, 1280)).toEqual({ left: 360, right: undefined });
  });

  it("shrinks the right panel first, then the left, never below their minimums", () => {
    // 1280 - 44 activity - 420 stage = 816 for both sidebars.
    expect(fitSidebarWidths(300, 640, 1280)).toEqual({ left: 300, right: 516 });
    expect(fitSidebarWidths(360, 640, 1100)).toEqual({ left: 356, right: 280 });
    expect(fitSidebarWidths(360, 640, 1000)).toEqual({ left: 256, right: 280 });
    expect(fitSidebarWidths(360, 640, 600)).toEqual({ left: 200, right: 280 });
    const fitted = fitSidebarWidths(360, 640, 1280);
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
