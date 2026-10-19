// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { SidebarShortcutTips, sidebarShortcutTips, sidebarShortcutTipsVisible } from "../src/renderer/ui/SidebarShortcutTips.js";

describe("Sidebar shortcut tips", () => {
  it("fills the sidebar only while fewer than eight Agent and Terminal rows are listed", () => {
    expect(sidebarShortcutTipsVisible(0)).toBe(true);
    expect(sidebarShortcutTipsVisible(7)).toBe(true);
    expect(sidebarShortcutTipsVisible(8)).toBe(false);
    expect(sidebarShortcutTipsVisible(20)).toBe(false);
  });

  it("labels the real shell bindings for each platform", () => {
    const mac = new Map(sidebarShortcutTips("mac").map((tip) => [tip.label, tip.keys]));
    expect(mac.get("Fork agent")).toBe("⌘F");
    expect(mac.get("Switch Project")).toBe("⌘1–9");
    expect(mac.get("Command palette")).toBe("⇧⌘P");
    const windows = new Map(sidebarShortcutTips("windows").map((tip) => [tip.label, tip.keys]));
    expect(windows.get("Fork agent")).toBe("Ctrl+Shift+F");
    expect(windows.get("Switch Project")).toBe("Ctrl+1–9");
  });

  it("renders every tip with its key chord", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(<SidebarShortcutTips platform="mac" />));
    const section = container.querySelector('[aria-label="Keyboard shortcuts"]')!;
    expect(section.querySelectorAll("dt")).toHaveLength(sidebarShortcutTips("mac").length);
    expect(section.textContent).toContain("Fork agent⌘F");
    await act(async () => root.unmount());
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
