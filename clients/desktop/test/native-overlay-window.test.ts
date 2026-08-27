import { describe, expect, it, vi } from "vitest";
import { isNativeOverlayWindowRequest, NativeOverlayWindowManager } from "../src/main/native-overlay-window.js";
import {
  nativeOverlayPassiveRegion,
  nativeOverlayPointerInteractiveAt,
  nativeTerminalSurfaceVisible,
} from "../src/renderer/composition/native-overlay-window.js";

describe("native overlay window request", () => {
  it("accepts the original frame name and numeric recovery generations", () => {
    expect(isNativeOverlayWindowRequest({ url: "about:blank", frameName: "termloop-native-overlay" })).toBe(true);
    expect(isNativeOverlayWindowRequest({ url: "about:blank", frameName: "termloop-native-overlay-0" })).toBe(true);
    expect(isNativeOverlayWindowRequest({ url: "about:blank", frameName: "termloop-native-overlay-17" })).toBe(true);
  });

  it("rejects unrelated URLs and lookalike frame names", () => {
    expect(isNativeOverlayWindowRequest({ url: "https://example.com", frameName: "termloop-native-overlay-1" })).toBe(false);
    expect(isNativeOverlayWindowRequest({ url: "about:blank", frameName: "termloop-native-overlay-extra" })).toBe(false);
    expect(isNativeOverlayWindowRequest({ url: "about:blank", frameName: "termloop-native-overlay-1-extra" })).toBe(false);
  });

  it("hides native terminal surfaces whenever shell content must render above them", () => {
    expect(nativeTerminalSurfaceVisible(false, false)).toBe(true);
    expect(nativeTerminalSurfaceVisible(false, true)).toBe(false);
    expect(nativeTerminalSurfaceVisible(true, false)).toBe(false);
    expect(nativeTerminalSurfaceVisible(true, true)).toBe(false);
  });

  it("hit-tests forwarded pointer coordinates instead of the event target", () => {
    let hitPet = true;
    let bubbleOpen = false;
    const getBoundingClientRect = vi.fn(() => ({
      left: 100, top: 100, right: 146, bottom: 170,
    }));
    const elementFromPoint = vi.fn(() => ({
      closest: vi.fn(() => hitPet ? {} : null),
    }));
    const overlayDocument = {
      elementFromPoint,
      querySelector: vi.fn((selector: string) => {
        if (selector === ".steward-pet") return { getBoundingClientRect };
        if (selector === ".steward-pet-bubble") return bubbleOpen ? {} : null;
        return null;
      }),
    } as unknown as Document;

    expect(nativeOverlayPointerInteractiveAt(overlayDocument, 32, 48)).toBe(true);
    expect(elementFromPoint).toHaveBeenCalledWith(32, 48);

    hitPet = false;
    expect(nativeOverlayPointerInteractiveAt(overlayDocument, 300, 200)).toBe(false);
    expect(nativeOverlayPointerInteractiveAt(overlayDocument, 88, 90, 14)).toBe(true);
    expect(nativeOverlayPointerInteractiveAt(overlayDocument, 75, 75, 14)).toBe(false);

    bubbleOpen = true;
    expect(nativeOverlayPointerInteractiveAt(overlayDocument, 300, 200)).toBe(false);
  });

  it("limits passive interaction to the pet and its open bubble", () => {
    const petRect = { left: 100, top: 100, right: 146, bottom: 170 };
    const bubbleRect = { left: 100, top: 20, right: 364, bottom: 106 };
    let bubbleOpen = false;
    const overlayDocument = {
      querySelector: vi.fn((selector: string) => {
        if (selector === ".steward-pet") return { getBoundingClientRect: () => petRect };
        if (selector === ".steward-pet-bubble" && bubbleOpen) {
          return { getBoundingClientRect: () => bubbleRect };
        }
        return null;
      }),
    } as unknown as Document;

    expect(nativeOverlayPassiveRegion(overlayDocument)).toEqual({ x: 100, y: 100, width: 46, height: 70 });
    bubbleOpen = true;
    expect(nativeOverlayPassiveRegion(overlayDocument)).toEqual({ x: 100, y: 20, width: 264, height: 150 });
  });

  it("keeps the passive pet window click-through until the pointer reaches the pet", () => {
    const parent = {
      on: vi.fn(), off: vi.fn(), isMinimized: vi.fn(() => false), isDestroyed: vi.fn(() => false),
      getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })), focus: vi.fn(),
    };
    const overlay = {
      webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
      on: vi.fn(), setBounds: vi.fn(), isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => true),
      show: vi.fn(), showInactive: vi.fn(), focus: vi.fn(), hide: vi.fn(), destroy: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
    };
    const manager = new NativeOverlayWindowManager(parent as never, vi.fn());
    manager.adopt(overlay as never, { url: "about:blank", frameName: "termloop-native-overlay-0" });

    manager.setPassiveVisible(true);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    expect(overlay.showInactive).toHaveBeenCalled();
    expect(overlay.focus).not.toHaveBeenCalled();

    manager.setPointerInteractive(true);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    expect(overlay.focus).not.toHaveBeenCalled();

    manager.setVisible(true);
    expect(overlay.show).toHaveBeenCalled();
    expect(overlay.focus).toHaveBeenCalled();

    manager.setVisible(false);
    expect(parent.focus).toHaveBeenCalled();
    expect(overlay.showInactive).toHaveBeenCalled();

    manager.setPassiveVisible(false);
    expect(overlay.hide).toHaveBeenCalled();
  });

  it("acquires the pet from the system cursor without waiting for a forwarded mousemove", () => {
    let cursor = { x: 125, y: 125 };
    const parent = {
      on: vi.fn(), off: vi.fn(), isMinimized: vi.fn(() => false), isDestroyed: vi.fn(() => false),
      getContentBounds: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })), focus: vi.fn(),
    };
    const overlay = {
      webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
      on: vi.fn(), setBounds: vi.fn(), isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => true),
      show: vi.fn(), showInactive: vi.fn(), focus: vi.fn(), hide: vi.fn(), destroy: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
    };
    const manager = new NativeOverlayWindowManager(parent as never, vi.fn(), () => cursor);
    manager.adopt(overlay as never, { url: "about:blank", frameName: "termloop-native-overlay-0" });
    manager.setPassiveRegion({ x: 100, y: 80, width: 46, height: 70 });
    manager.setPassiveVisible(true);

    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);

    cursor = { x: 500, y: 500 };
    manager.setPassiveRegion({ x: 100, y: 80, width: 46, height: 70 });
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    manager.dispose();
  });

  it("does not request overlay recovery while disposing the parent window", () => {
    const overlayClosed = vi.fn();
    const overlayListeners = new Map<string, () => void>();
    const parent = {
      on: vi.fn(), off: vi.fn(), isMinimized: vi.fn(() => false), isDestroyed: vi.fn(() => false),
      getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })), focus: vi.fn(),
    };
    const overlay = {
      webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
      on: vi.fn((event: string, listener: () => void) => overlayListeners.set(event, listener)),
      setBounds: vi.fn(), isDestroyed: vi.fn(() => false), show: vi.fn(), showInactive: vi.fn(),
      focus: vi.fn(), hide: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      destroy: vi.fn(() => overlayListeners.get("closed")?.()),
    };
    const manager = new NativeOverlayWindowManager(parent as never, overlayClosed);
    manager.adopt(overlay as never, { url: "about:blank", frameName: "termloop-native-overlay-0" });

    manager.dispose();

    expect(overlay.destroy).toHaveBeenCalledOnce();
    expect(overlayClosed).not.toHaveBeenCalled();
    expect(manager.handleWindowOpen({
      url: "about:blank",
      frameName: "termloop-native-overlay-1",
    } as never)).toEqual({ action: "deny" });
  });
});
