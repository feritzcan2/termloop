// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { SidebarShortcutTips, sidebarShortcutTips, sidebarShortcutTipsFit } from "../src/renderer/ui/SidebarShortcutTips.js";

describe("Sidebar shortcut tips", () => {
  it("appears only in the room the rail rows leave empty", () => {
    expect(sidebarShortcutTipsFit(600, 400, 130, 0)).toBe(true);
    expect(sidebarShortcutTipsFit(600, 480, 130, 0)).toBe(false);
    // Once shown, the card already took its height from the rail viewport.
    expect(sidebarShortcutTipsFit(470, 400, 130, 130)).toBe(true);
    expect(sidebarShortcutTipsFit(470, 480, 130, 130)).toBe(false);
  });

  it("lists Quick Action first and Rename right under Fork with the real bindings", () => {
    expect(sidebarShortcutTips("mac")).toEqual([
      { label: "Quick Action", keys: "Shift Shift" },
      { label: "Fork agent", keys: "⌘F" },
      { label: "Rename session", keys: "⌘R" },
      { label: "Switch Project", keys: "⌘1–9" },
      { label: "New terminal", keys: "⌘T" },
    ]);
    const windows = new Map(sidebarShortcutTips("windows").map((tip) => [tip.label, tip.keys]));
    expect(windows.get("Fork agent")).toBe("Ctrl+Shift+F");
    expect(windows.get("Switch Project")).toBe("Ctrl+1–9");
  });

  it("renders every tip with its key chord and stays hidden until it is measured to fit", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(<SidebarShortcutTips platform="mac" scrollRef={createRef()} />));
    const section = container.querySelector<HTMLElement>('[aria-label="Keyboard shortcuts"]')!;
    expect(section.hidden).toBe(true);
    expect(section.querySelectorAll("dt")).toHaveLength(sidebarShortcutTips("mac").length);
    expect(section.textContent).toContain("Fork agent⌘F");
    await act(async () => root.unmount());
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
