// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailHeader } from "../src/renderer/ui/RailHeader.js";

describe("Rail header click surface", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("toggles from the chevron and non-interactive header surface", async () => {
    const toggle = vi.fn();
    await act(async () => root.render(createElement(RailHeader, {
      collapsed: false,
      label: "Tasks",
      toggle,
      children: createElement("h2", null, "Tasks"),
    })));

    await act(async () => (container.querySelector(".rail-toggle") as HTMLButtonElement).click());
    await act(async () => (container.querySelector("h2") as HTMLHeadingElement).click());
    await act(async () => (container.querySelector(".rail-header") as HTMLElement).click());

    expect(toggle).toHaveBeenCalledTimes(3);
  });

  it("leaves nested header actions independent from disclosure", async () => {
    const toggle = vi.fn();
    const action = vi.fn();
    await act(async () => root.render(createElement(RailHeader, {
      collapsed: false,
      label: "Active Agents",
      toggle,
      children: createElement("button", { type: "button", className: "header-action", onClick: action }, "Changes"),
    })));

    await act(async () => (container.querySelector(".header-action") as HTMLButtonElement).click());

    expect(action).toHaveBeenCalledOnce();
    expect(toggle).not.toHaveBeenCalled();
  });
});
