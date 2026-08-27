import type { BrowserWindow, HandlerDetails, WindowOpenHandlerResponse } from "electron";

export const NATIVE_OVERLAY_FRAME_NAME = "termloop-native-overlay";

export type NativeOverlayPassiveRegion = { x: number; y: number; width: number; height: number };
type ScreenPoint = { x: number; y: number };

export function isNativeOverlayWindowRequest(details: Pick<HandlerDetails, "url" | "frameName">): boolean {
  if (details.url !== "about:blank") return false;
  if (details.frameName === NATIVE_OVERLAY_FRAME_NAME) return true;
  const generation = details.frameName.slice(NATIVE_OVERLAY_FRAME_NAME.length + 1);
  return details.frameName.startsWith(`${NATIVE_OVERLAY_FRAME_NAME}-`)
    && /^\d+$/.test(generation);
}

export class NativeOverlayWindowManager {
  readonly #parent: BrowserWindow;
  readonly #overlayClosed: () => void;
  readonly #cursorScreenPoint: () => ScreenPoint;
  #overlay: BrowserWindow | undefined;
  #visible = false;
  #passiveVisible = false;
  #requestedPointerInteractive = false;
  #cursorPointerInteractive = false;
  #passiveRegion: NativeOverlayPassiveRegion | undefined;
  #cursorPoll: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(parent: BrowserWindow, overlayClosed: () => void, cursorScreenPoint: () => ScreenPoint = () => ({ x: -1, y: -1 })) {
    this.#parent = parent;
    this.#overlayClosed = overlayClosed;
    this.#cursorScreenPoint = cursorScreenPoint;
    parent.on("move", this.#syncBounds);
    parent.on("resize", this.#syncBounds);
    parent.on("enter-full-screen", this.#syncBounds);
    parent.on("leave-full-screen", this.#syncBounds);
    parent.on("minimize", this.#hideForParent);
    parent.on("restore", this.#restoreForParent);
  }

  handleWindowOpen = (details: HandlerDetails): WindowOpenHandlerResponse => {
    if (this.#disposed || !isNativeOverlayWindowRequest(details) || this.#overlay) return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        parent: this.#parent,
        frame: false,
        transparent: true,
        show: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        backgroundColor: "#00000000",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  };

  adopt(window: BrowserWindow, details: Pick<HandlerDetails, "url" | "frameName">): void {
    if (this.#disposed || !isNativeOverlayWindowRequest(details) || this.#overlay) {
      window.destroy();
      return;
    }
    this.#overlay = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => {
      if (this.#overlay === window) this.#overlay = undefined;
      this.#updateCursorPolling();
      if (!this.#disposed) this.#overlayClosed();
    });
    this.#syncBounds();
    this.#updateCursorPolling();
    this.#applyVisibility();
  }

  setVisible(visible: boolean): void {
    const restoreParentFocus = this.#visible && !visible;
    this.#visible = visible;
    this.#updateCursorPolling();
    this.#applyVisibility();
    if (restoreParentFocus && !this.#parent.isDestroyed() && !this.#parent.isMinimized()) this.#parent.focus();
  }

  setPassiveVisible(visible: boolean): void {
    this.#passiveVisible = visible;
    if (!visible) {
      this.#requestedPointerInteractive = false;
      this.#cursorPointerInteractive = false;
    }
    this.#updateCursorPolling();
    this.#applyVisibility();
  }

  setPointerInteractive(interactive: boolean): void {
    this.#requestedPointerInteractive = interactive;
    if (!this.#visible && this.#passiveVisible) this.#applyVisibility();
  }

  setPassiveRegion(region: NativeOverlayPassiveRegion | undefined): void {
    this.#passiveRegion = region;
    this.#updateCursorPolling();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#parent.off("move", this.#syncBounds);
    this.#parent.off("resize", this.#syncBounds);
    this.#parent.off("enter-full-screen", this.#syncBounds);
    this.#parent.off("leave-full-screen", this.#syncBounds);
    this.#parent.off("minimize", this.#hideForParent);
    this.#parent.off("restore", this.#restoreForParent);
    this.#stopCursorPolling();
    if (this.#overlay && !this.#overlay.isDestroyed()) this.#overlay.destroy();
    this.#overlay = undefined;
  }

  #syncBounds = (): void => {
    if (!this.#overlay || this.#overlay.isDestroyed() || this.#parent.isDestroyed()) return;
    this.#overlay.setBounds(this.#parent.getContentBounds(), false);
  };

  #hideForParent = (): void => {
    this.#updateCursorPolling();
    if (this.#overlay && !this.#overlay.isDestroyed()) this.#overlay.hide();
  };

  #restoreForParent = (): void => {
    this.#updateCursorPolling();
    this.#applyVisibility();
  };

  #stopCursorPolling = (): void => {
    if (this.#cursorPoll === undefined) return;
    clearInterval(this.#cursorPoll);
    this.#cursorPoll = undefined;
  };

  #updateCursorPolling = (): void => {
    const shouldPoll = Boolean(
      this.#overlay && !this.#overlay.isDestroyed()
      && this.#passiveVisible && !this.#visible && this.#passiveRegion
      && !this.#parent.isDestroyed() && !this.#parent.isMinimized(),
    );
    if (!shouldPoll) {
      this.#stopCursorPolling();
      const wasInteractive = this.#cursorPointerInteractive;
      this.#cursorPointerInteractive = false;
      if (wasInteractive) this.#applyVisibility();
      return;
    }
    this.#syncPointerFromCursor();
    this.#cursorPoll ??= setInterval(this.#syncPointerFromCursor, 32);
  };

  #syncPointerFromCursor = (): void => {
    const region = this.#passiveRegion;
    if (!region || !this.#passiveVisible || this.#visible || this.#parent.isDestroyed()) return;
    const cursor = this.#cursorScreenPoint();
    const bounds = this.#parent.getContentBounds();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    const padding = this.#cursorPointerInteractive ? 24 : 14;
    const interactive = x >= region.x - padding && x <= region.x + region.width + padding
      && y >= region.y - padding && y <= region.y + region.height + padding;
    if (interactive === this.#cursorPointerInteractive) return;
    this.#cursorPointerInteractive = interactive;
    this.#applyVisibility();
  };

  #applyVisibility = (): void => {
    const overlay = this.#overlay;
    if (!overlay || overlay.isDestroyed()) return;
    this.#syncBounds();
    if (this.#parent.isMinimized() || (!this.#visible && !this.#passiveVisible)) {
      overlay.hide();
      return;
    }
    if (this.#visible) {
      overlay.setIgnoreMouseEvents(false);
      overlay.show();
      overlay.focus();
      return;
    }
    if (this.#requestedPointerInteractive || this.#cursorPointerInteractive) overlay.setIgnoreMouseEvents(false);
    else overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.showInactive();
  };
}
