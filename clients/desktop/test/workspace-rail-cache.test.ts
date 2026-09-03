// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRailCache } from "../src/renderer/ui/WorkspaceRailCache.js";

describe("WorkspaceRailCache", () => {
  afterEach(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps cached rail state mounted while a peer tab is visible", async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const Child = () => {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return createElement("p", null, "Cached Tasks");
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => root.render(createElement(WorkspaceRailCache, { visible: true, children: createElement(Child) })));
    await act(async () => root.render(createElement(WorkspaceRailCache, { visible: false, children: createElement(Child) })));

    expect(container.firstElementChild?.hasAttribute("hidden")).toBe(true);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();

    await act(async () => root.render(createElement(WorkspaceRailCache, { visible: true, children: createElement(Child) })));
    expect(container.textContent).toContain("Cached Tasks");
    expect(mounted).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    container.remove();
    expect(unmounted).toHaveBeenCalledTimes(1);
  });
});
