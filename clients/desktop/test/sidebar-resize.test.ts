// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarResizeHandle } from "../src/renderer/ui/Shell.js";

describe("sidebar resize pointer lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let handle: HTMLDivElement;
  let captured: number | undefined;
  const resize = vi.fn();
  const reset = vi.fn();
  const draggingChanged = vi.fn();

  async function pointer(target: EventTarget, type: string, init: MouseEventInit & { pointerId?: number; isPrimary?: boolean } = {}) {
    const event = new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, clientX: 340, ...init });
    Object.defineProperties(event, {
      pointerId: { value: init.pointerId ?? 1 },
      isPrimary: { value: init.isPrimary ?? true },
    });
    await act(async () => { target.dispatchEvent(event); });
  }

  function expectFinished() {
    expect(handle.classList.contains("dragging")).toBe(false);
    expect(draggingChanged.mock.calls).toEqual([[true], [false]]);
    expect(captured).toBeUndefined();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    captured = undefined;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(SidebarResizeHandle, { width: 320, resize, reset, draggingChanged })));
    handle = container.querySelector<HTMLDivElement>('[role="separator"]')!;
    handle.setPointerCapture = vi.fn((id) => { captured = id; });
    handle.hasPointerCapture = vi.fn((id) => captured === id);
    handle.releasePointerCapture = vi.fn(() => { captured = undefined; });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("resizes only during a primary-button drag and restores terminals on release", async () => {
    await pointer(handle, "pointermove");
    expect(resize).not.toHaveBeenCalled();
    await pointer(handle, "pointerdown");
    expect(draggingChanged).toHaveBeenLastCalledWith(true);
    await pointer(handle, "pointermove", { clientX: 380 });
    expect(resize).toHaveBeenLastCalledWith(380);
    await pointer(handle, "pointerup", { buttons: 0 });
    expectFinished();
    await pointer(handle, "pointermove", { buttons: 0 });
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("restores terminals when a native window takes pointer capture", async () => {
    await pointer(handle, "pointerdown");
    captured = undefined;
    await pointer(handle, "lostpointercapture");
    expectFinished();
    await pointer(handle, "pointermove", { buttons: 0 });
    expect(resize).not.toHaveBeenCalled();
    await pointer(handle, "pointerdown");
    await pointer(handle, "pointermove", { clientX: 400 });
    await pointer(handle, "pointerup", { buttons: 0 });
    expect(resize).toHaveBeenLastCalledWith(400);
    expect(draggingChanged.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it.each(["pointerup", "pointercancel"])("finishes on a %s outside the handle", async (type) => {
    await pointer(handle, "pointerdown");
    await pointer(document, type, { buttons: 0 });
    expectFinished();
    await pointer(handle, "lostpointercapture");
    expectFinished();
  });

  it("recovers from a missed release without resizing on the next hover", async () => {
    await pointer(handle, "pointerdown");
    await pointer(document, "pointermove", { buttons: 0, clientX: 900 });
    expectFinished();
    expect(resize).not.toHaveBeenCalled();
  });

  it.each(["blur", "pagehide"])("releases capture on window %s", async (type) => {
    await pointer(handle, "pointerdown");
    await act(async () => { window.dispatchEvent(new Event(type)); });
    expectFinished();
  });

  it("cancels with Escape and removes the key listener afterwards", async () => {
    await pointer(handle, "pointerdown");
    const escape = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const activeEscape = escape();
    await act(async () => { document.dispatchEvent(activeEscape); });
    expectFinished();
    expect(activeEscape.defaultPrevented).toBe(true);
    const idleEscape = escape();
    document.dispatchEvent(idleEscape);
    expect(idleEscape.defaultPrevented).toBe(false);
  });

  it("finishes when the document becomes hidden", async () => {
    await pointer(handle, "pointerdown");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expectFinished();
  });

  it("cleans up capture and terminal occlusion when the handle unmounts", async () => {
    await pointer(handle, "pointerdown");
    await act(async () => root.render(null));
    expect(captured).toBeUndefined();
    expect(draggingChanged.mock.calls).toEqual([[true], [false]]);
    await pointer(document, "pointermove");
    expect(resize).not.toHaveBeenCalled();
  });

  it("ignores right clicks and secondary pointers", async () => {
    await pointer(handle, "pointerdown", { button: 2, buttons: 2 });
    await pointer(handle, "pointerdown", { isPrimary: false, pointerId: 2 });
    expect(draggingChanged).not.toHaveBeenCalled();
    expect(captured).toBeUndefined();
    await pointer(handle, "pointerdown");
    await pointer(handle, "pointerdown", { pointerId: 2 });
    await pointer(document, "pointerup", { pointerId: 2, buttons: 0 });
    await pointer(document, "pointermove", { pointerId: 2, buttons: 0 });
    expect(captured).toBe(1);
    expect(draggingChanged.mock.calls).toEqual([[true]]);
    await pointer(handle, "pointerup", { buttons: 0 });
    expectFinished();
  });

  it("preserves keyboard resizing and double-click reset", async () => {
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(resize).toHaveBeenLastCalledWith(360);
    expect(reset).toHaveBeenCalledOnce();
    expect(draggingChanged).not.toHaveBeenCalled();
  });
});
