import { describe, expect, it, vi } from "vitest";
import { isNativeOverlayWindowRequest, NativeOverlayWindowManager } from "../src/main/native-overlay-window.js";
import {
  nativeOverlayPassiveVisible,
  nativeOverlayPassiveRegion,
  nativeOverlayPointerInteractiveAt,
  overlayOpenTiming,
  terminalSurfaceVisible,
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

  it("preserves Ghostty snapshots behind shell overlays", () => {
    expect(terminalSurfaceVisible("ghostty", false, false)).toBe(true);
    expect(terminalSurfaceVisible("ghostty", false, true)).toBe(false);
    expect(terminalSurfaceVisible("ghostty", true, false)).toBe(false);
    expect(terminalSurfaceVisible("ghostty", true, true)).toBe(false);
    expect(terminalSurfaceVisible("ghostty", false, true, true)).toBe(false);
  });

  it("keeps Windows Terminal live beneath the separate overlay window", () => {
    expect(terminalSurfaceVisible("windows-terminal", false, false)).toBe(true);
    expect(terminalSurfaceVisible("windows-terminal", false, true, true)).toBe(true);
    expect(terminalSurfaceVisible("windows-terminal", false, false, true)).toBe(true);
  });

  it("hides Windows Terminal while overlays fall back to the main document", () => {
    expect(terminalSurfaceVisible("windows-terminal", false, true)).toBe(false);
    expect(terminalSurfaceVisible("windows-terminal", false, true, false)).toBe(false);
  });

  it("still hides Windows Terminal for stage content and drag targets", () => {
    expect(terminalSurfaceVisible("windows-terminal", true, false)).toBe(false);
    expect(terminalSurfaceVisible("windows-terminal", true, true, true)).toBe(false);
    expect(terminalSurfaceVisible("windows-terminal", true, false, true)).toBe(false);
  });

  it("keeps xterm visible behind Quick Action and other DOM dialogs", () => {
    expect(terminalSurfaceVisible("xterm", false, false)).toBe(true);
    expect(terminalSurfaceVisible("xterm", false, true)).toBe(true);
  });

  it("still hides xterm when the terminal stage itself is occluded", () => {
    expect(terminalSurfaceVisible("xterm", true, false)).toBe(false);
    expect(terminalSurfaceVisible("xterm", true, true)).toBe(false);
  });

  it("hides the passive native overlay while a DOM-owned dialog is open", () => {
    expect(nativeOverlayPassiveVisible(true, false)).toBe(true);
    expect(nativeOverlayPassiveVisible(true, true)).toBe(false);
    expect(nativeOverlayPassiveVisible(false, false)).toBe(false);
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

  it("logs which window received each mouse-down and the overlay mode at that moment", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const listeners = new Map<string, (event: unknown, input: { type: string; x?: number; y?: number }) => void>();
    const recorder = (target: string) => vi.fn((name: string, listener: never) => {
      if (name === "input-event") listeners.set(target, listener);
    });
    const parent = {
      on: vi.fn(), off: vi.fn(), isMinimized: vi.fn(() => false), isDestroyed: vi.fn(() => false),
      getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })), focus: vi.fn(),
      webContents: { on: recorder("parent") },
    };
    const overlay = {
      webContents: { setWindowOpenHandler: vi.fn(), on: recorder("overlay") },
      on: vi.fn(), setBounds: vi.fn(), isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => true),
      show: vi.fn(), showInactive: vi.fn(), focus: vi.fn(), hide: vi.fn(), destroy: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
    };
    const manager = new NativeOverlayWindowManager(parent as never, vi.fn());
    manager.adopt(overlay as never, { url: "about:blank", frameName: "termloop-native-overlay-0" });
    manager.setPassiveVisible(true);

    listeners.get("parent")?.({}, { type: "mouseDown", x: 40, y: 12 });
    listeners.get("parent")?.({}, { type: "mouseMove", x: 41, y: 12 });
    manager.setVisible(true);
    listeners.get("overlay")?.({}, { type: "mouseDown", x: 60, y: 80 });

    const lines = info.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes("mouseDown"))).toEqual([
      expect.stringContaining("target=parent x=40 y=12 mode=passive-clickthrough"),
      expect.stringContaining("target=overlay x=60 y=80 mode=interactive"),
    ]);
    expect(lines).toContainEqual(expect.stringContaining("setVisible visible=true from=passive-clickthrough"));
    info.mockRestore();
  });

  it("relays only the renderer's overlay timing lines into the main log", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let consoleListener: ((details: { message?: unknown }) => void) | undefined;
    const parent = {
      on: vi.fn(), off: vi.fn(), isMinimized: vi.fn(() => false), isDestroyed: vi.fn(() => false),
      getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })), focus: vi.fn(),
      webContents: { on: vi.fn((name: string, listener: never) => {
        if (name === "console-message") consoleListener = listener;
      }) },
    };
    new NativeOverlayWindowManager(parent as never, vi.fn());

    consoleListener?.({ message: "[overlay-diag] t rendererOpen clickToCommit=12ms ipc=3ms" });
    consoleListener?.({ message: "[changes-diag] {\"event\":\"editableDiffFallback\"}" });
    consoleListener?.({ message: "unrelated renderer log with private text" });
    consoleListener?.({ message: 42 });

    expect(info.mock.calls.map(([line]) => String(line))).toEqual([
      "[overlay-diag] t rendererOpen clickToCommit=12ms ipc=3ms",
      "[changes-diag] {\"event\":\"editableDiffFallback\"}",
    ]);
    info.mockRestore();
  });

  it("splits an overlay open into click-to-commit and IPC time", () => {
    expect(overlayOpenTiming(100, 1_350.4, 1_362.6)).toContain("rendererOpen clickToCommit=1250ms ipc=12ms");
    // A keyboard open or a stale pointer-down is not attributed to the click.
    expect(overlayOpenTiming(undefined, 50, 60)).toContain("clickToCommit=unknown ipc=10ms");
    expect(overlayOpenTiming(0, 9_000, 9_004)).toContain("clickToCommit=unknown ipc=4ms");
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
