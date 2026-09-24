import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export function useSidebarResizeDrag(resize: (width: number) => void, draggingChanged: (dragging: boolean) => void) {
  const [dragging, setDragging] = useState(false);
  const finishRef = useRef<(() => void) | undefined>(undefined);
  const callbacks = useRef({ resize, draggingChanged });
  callbacks.current = { resize, draggingChanged };

  useEffect(() => () => finishRef.current?.(), []);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || finishRef.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const document = handle.ownerDocument;
    const window = document.defaultView;
    handle.setPointerCapture(pointerId);

    const finish = () => {
      if (finishRef.current !== finish) return;
      finishRef.current = undefined;
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", finishPointer, true);
      document.removeEventListener("pointercancel", finishPointer, true);
      document.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("visibilitychange", visibilityChanged);
      handle.removeEventListener("lostpointercapture", finishPointer);
      window?.removeEventListener("blur", finish);
      window?.removeEventListener("pagehide", finish);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      setDragging(false);
      callbacks.current.draggingChanged(false);
    };
    const finishPointer = (pointer: PointerEvent) => {
      if (pointer.pointerId === pointerId) finish();
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      // A native child window can consume the release. The first hover back
      // in Chromium must restore the terminal instead of continuing to resize.
      if ((pointer.buttons & 1) === 0) { finish(); return; }
      callbacks.current.resize(pointer.clientX);
    };
    const keyDown = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      finish();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") finish();
    };

    // Listen beyond the handle: Windows can transfer capture/focus to a native
    // terminal HWND before Chromium delivers pointerup to the original target.
    finishRef.current = finish;
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", finishPointer, true);
    document.addEventListener("pointercancel", finishPointer, true);
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("visibilitychange", visibilityChanged);
    handle.addEventListener("lostpointercapture", finishPointer);
    window?.addEventListener("blur", finish);
    window?.addEventListener("pagehide", finish);
    setDragging(true);
    callbacks.current.draggingChanged(true);
  };

  return { dragging, startDrag };
}
