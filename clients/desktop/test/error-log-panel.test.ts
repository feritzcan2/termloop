// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorLogPanel } from "../src/renderer/ui/ErrorLogPanel.js";

describe("sidebar error log", () => {
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

  it("opens from the footer and renders newest errors first", async () => {
    await act(async () => root.render(createElement(ErrorLogPanel, {
      entries: [
        { id: 1, message: "older failure", occurredAtEpochMs: Date.UTC(2026, 0, 1, 10, 0, 0) },
        { id: 2, message: "newer failure", occurredAtEpochMs: Date.UTC(2026, 0, 1, 10, 1, 0) },
      ],
      clear: vi.fn(),
    })));

    expect(container.querySelector(".error-log-trigger")?.textContent).toContain("Errors2");
    await act(async () => (container.querySelector(".error-log-trigger") as HTMLButtonElement).click());

    const messages = [...container.querySelectorAll(".error-log-panel li p")].map((node) => node.textContent);
    expect(messages).toEqual(["newer failure", "older failure"]);
  });

  it("exposes an empty state and clear action", async () => {
    const clear = vi.fn();
    await act(async () => root.render(createElement(ErrorLogPanel, {
      entries: [{ id: 1, message: "failure", occurredAtEpochMs: 1 }],
      clear,
    })));
    await act(async () => (container.querySelector(".error-log-trigger") as HTMLButtonElement).click());
    await act(async () => (container.querySelector(".error-log-panel header button") as HTMLButtonElement).click());
    expect(clear).toHaveBeenCalledOnce();

    await act(async () => root.render(createElement(ErrorLogPanel, { entries: [], clear })));
    expect(container.querySelector(".error-log-empty")?.textContent).toBe("No errors in this app run.");
    expect((container.querySelector(".error-log-panel header button") as HTMLButtonElement).disabled).toBe(true);
  });
});
