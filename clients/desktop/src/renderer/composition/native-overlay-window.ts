import { useEffect, useRef, useState } from "react";

const FRAME_NAME = "termloop-native-overlay";
const MASK_LAYER_ID = "native-overlay-terminal-masks";

function terminalMaskLayer(document: Document): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`#${MASK_LAYER_ID}`);
  if (existing) return existing;
  const layer = document.createElement("div");
  layer.id = MASK_LAYER_ID;
  layer.style.position = "fixed";
  layer.style.inset = "0";
  layer.style.zIndex = "0";
  layer.style.pointerEvents = "none";
  document.body.append(layer);
  return layer;
}

function updateTerminalMasks(container: HTMLElement, visible: boolean): void {
  const layer = terminalMaskLayer(container.ownerDocument);
  if (!visible) {
    layer.replaceChildren();
    return;
  }
  const masks: HTMLElement[] = [];
  for (const host of window.document.querySelectorAll<HTMLElement>(".terminal-mount, .assistant-terminal-host")) {
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const snapshot = host.querySelector<HTMLElement>(":scope > .terminal-native-snapshot");
    // Until Ghostty has captured its current frame, leave this part of the
    // transparent child window clear. The still-visible native surface is a
    // faithful fallback; an opaque empty mask would flash a blank terminal.
    if (!snapshot) continue;
    if (snapshot instanceof HTMLImageElement
      && (!snapshot.complete || snapshot.naturalWidth <= 0 || snapshot.naturalHeight <= 0)) continue;
    const mask = container.ownerDocument.createElement("div");
    mask.style.position = "absolute";
    mask.style.left = `${rect.left}px`;
    mask.style.top = `${rect.top}px`;
    mask.style.width = `${rect.width}px`;
    mask.style.height = `${rect.height}px`;
    mask.style.background = "#282c34";
    mask.append(container.ownerDocument.importNode(snapshot, true));
    masks.push(mask);
  }
  const unchanged = layer.children.length === masks.length
    && masks.every((mask, index) => layer.children[index]?.isEqualNode(mask));
  if (!unchanged) layer.replaceChildren(...masks);
}

export function nativeTerminalSurfaceVisible(terminalOccluded: boolean, nativeOverlayActive: boolean): boolean {
  return !terminalOccluded && !nativeOverlayActive;
}

export function nativeOverlayPassiveVisible(hasSelectedProject: boolean, suppressed: boolean): boolean {
  return hasSelectedProject && !suppressed;
}

export function nativeOverlayPointerInteractiveAt(
  document: Document,
  clientX: number,
  clientY: number,
  padding = 0,
): boolean {
  const pet = document.querySelector<HTMLElement>(".steward-pet");
  if (pet) {
    const rect = pet.getBoundingClientRect();
    if (clientX >= rect.left - padding && clientX <= rect.right + padding
      && clientY >= rect.top - padding && clientY <= rect.bottom + padding) return true;
  }
  const element = document.elementFromPoint(clientX, clientY);
  return Boolean(element?.closest(".steward-pet"));
}

export function nativeOverlayPassiveRegion(
  document: Document,
): { x: number; y: number; width: number; height: number } | null {
  const pet = document.querySelector<HTMLElement>(".steward-pet");
  if (!pet) return null;
  const rects = [
    pet.getBoundingClientRect(),
    document.querySelector<HTMLElement>(".steward-pet-bubble")?.getBoundingClientRect(),
  ].filter((rect): rect is DOMRect => rect !== undefined);
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function useNativeOverlayWindow(
  enabled: boolean,
  visible: boolean,
  passiveVisible: boolean,
  setVisible: (visible: boolean) => Promise<void>,
  setPassiveVisible: (visible: boolean) => Promise<void>,
  setPointerInteractive: (interactive: boolean) => Promise<void>,
  setPassiveRegion: (region: { x: number; y: number; width: number; height: number } | null) => Promise<void>,
): HTMLElement | undefined {
  const [container, setContainer] = useState<HTMLElement>();
  const popupRef = useRef<Window | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const frameGenerationRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
    let disposed = false;
    let reopenTimer: number | undefined;
    let removePopupListeners = () => {};

    const openPopup = () => {
      if (disposed) return;
      removePopupListeners();
      const popup = popupRef.current && !popupRef.current.closed
        ? popupRef.current
        : window.open(
          "about:blank",
          `${FRAME_NAME}-${frameGenerationRef.current++}`,
          "popup=yes,width=1,height=1",
        ) ?? undefined;
      if (!popup) return;
      popupRef.current = popup;
      const initialize = () => {
        if (disposed || popup.closed || popupRef.current !== popup) return;
        const document = popup.document;
        document.title = "TermLoop Overlay";
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
        document.body.style.margin = "0";
        document.body.style.overflow = "hidden";
        terminalMaskLayer(document);
        if (!document.head.querySelector('[data-termloop-overlay-style="true"]')) {
          for (const stylesheet of window.document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
            const clone = stylesheet.cloneNode(true) as HTMLLinkElement;
            clone.href = stylesheet.href;
            clone.dataset.termloopOverlayStyle = "true";
            document.head.append(clone);
          }
          for (const style of window.document.querySelectorAll<HTMLStyleElement>("style")) {
            const clone = style.cloneNode(true) as HTMLStyleElement;
            clone.dataset.termloopOverlayStyle = "true";
            document.head.append(clone);
          }
        }
        const root = document.querySelector<HTMLElement>("#native-overlay-root") ?? document.createElement("div");
        root.id = "native-overlay-root";
        root.style.width = "100vw";
        root.style.height = "100vh";
        root.style.background = "transparent";
        root.style.position = "fixed";
        root.style.inset = "0";
        root.style.zIndex = "1";
        if (!root.isConnected) document.body.append(root);
        setContainer(root);
      };
      popup.addEventListener("load", initialize, { once: true });
      const initializeFallback = window.setTimeout(initialize, 50);
      removePopupListeners = () => {
        popup.removeEventListener("load", initialize);
        window.clearTimeout(initializeFallback);
      };
    };

    const recover = (event: MessageEvent) => {
      const data = event.data as { source?: unknown; type?: unknown } | undefined;
      if (data?.source !== "termloop" || data.type !== "native-overlay-closed") return;
      removePopupListeners();
      popupRef.current = undefined;
      setContainer(undefined);
      if (reopenTimer !== undefined) window.clearTimeout(reopenTimer);
      reopenTimer = window.setTimeout(() => {
        reopenTimer = undefined;
        openPopup();
      }, 0);
    };
    window.addEventListener("message", recover);
    openPopup();
    return () => {
      disposed = true;
      window.removeEventListener("message", recover);
      removePopupListeners();
      if (reopenTimer !== undefined) window.clearTimeout(reopenTimer);
      const popup = popupRef.current;
      closeTimerRef.current = window.setTimeout(() => {
        setContainer(undefined);
        if (popup && !popup.closed) popup.close();
        if (popupRef.current === popup) popupRef.current = undefined;
        closeTimerRef.current = undefined;
      }, 0);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !container) return;
    let active = true;
    let syncFrame: number | undefined;
    const sync = () => updateTerminalMasks(container, visible);
    const scheduleSync = () => {
      if (syncFrame !== undefined) return;
      syncFrame = window.requestAnimationFrame(() => {
        syncFrame = undefined;
        sync();
      });
    };
    if (visible) sync();
    void setVisible(visible)
      .then(() => {
        if (active && !visible) updateTerminalMasks(container, false);
      })
      .catch(() => undefined);
    const observer = visible ? new MutationObserver(scheduleSync) : undefined;
    if (visible) {
      observer?.observe(window.document.body, { childList: true, subtree: true });
      window.addEventListener("resize", scheduleSync);
      window.document.addEventListener("load", scheduleSync, true);
    }
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      window.document.removeEventListener("load", scheduleSync, true);
      if (syncFrame !== undefined) window.cancelAnimationFrame(syncFrame);
    };
  }, [container, enabled, setVisible, visible]);

  useEffect(() => {
    if (!enabled) return;
    void setPassiveVisible(passiveVisible).catch(() => undefined);
    return () => { void setPassiveVisible(false).catch(() => undefined); };
  }, [enabled, passiveVisible, setPassiveVisible]);

  useEffect(() => {
    if (!enabled || !container || !passiveVisible || visible) return;
    const overlayDocument = container.ownerDocument;
    let pointerPosition: { x: number; y: number } | undefined;
    let interactive = false;
    const syncInteraction = () => {
      const next = Boolean(pointerPosition && nativeOverlayPointerInteractiveAt(
        overlayDocument,
        pointerPosition.x,
        pointerPosition.y,
        interactive ? 24 : 14,
      ));
      if (next === interactive) return;
      interactive = next;
      void setPointerInteractive(next).catch(() => undefined);
    };
    const pointerMoved = (event: PointerEvent) => {
      // Electron's forwarded mousemove targets the transparent overlay page,
      // not the descendant underneath the pointer. Hit-test the overlay DOM by
      // coordinates so the passive window becomes interactive over the pet.
      pointerPosition = { x: event.clientX, y: event.clientY };
      syncInteraction();
    };
    const observer = new MutationObserver(syncInteraction);
    overlayDocument.addEventListener("pointermove", pointerMoved);
    observer.observe(container, { childList: true, subtree: true });
    syncInteraction();
    return () => {
      overlayDocument.removeEventListener("pointermove", pointerMoved);
      observer.disconnect();
      if (interactive) void setPointerInteractive(false).catch(() => undefined);
    };
  }, [container, enabled, passiveVisible, setPointerInteractive, visible]);

  useEffect(() => {
    if (!enabled || !container || !passiveVisible) return;
    const overlayWindow = container.ownerDocument.defaultView;
    let animationFrame: number | undefined;
    let previous = "";
    const syncRegion = () => {
      animationFrame = undefined;
      const region = nativeOverlayPassiveRegion(container.ownerDocument);
      const serialized = region ? `${region.x}:${region.y}:${region.width}:${region.height}` : "null";
      if (serialized === previous) return;
      previous = serialized;
      void setPassiveRegion(region).catch(() => undefined);
    };
    const scheduleSync = () => {
      if (animationFrame !== undefined) return;
      animationFrame = window.requestAnimationFrame(syncRegion);
    };
    const Observer = overlayWindow?.MutationObserver ?? MutationObserver;
    const observer = new Observer(scheduleSync);
    observer.observe(container, { attributes: true, childList: true, subtree: true });
    overlayWindow?.addEventListener("resize", scheduleSync);
    syncRegion();
    return () => {
      observer.disconnect();
      overlayWindow?.removeEventListener("resize", scheduleSync);
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      void setPassiveRegion(null).catch(() => undefined);
    };
  }, [container, enabled, passiveVisible, setPassiveRegion]);

  useEffect(() => {
    if (!enabled || !container) return;
    return () => {
      void setVisible(false)
        .then(() => updateTerminalMasks(container, false))
        .catch(() => undefined);
    };
  }, [container, enabled, setVisible]);

  return container;
}
