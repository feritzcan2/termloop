import { useCallback, useEffect, useState, type RefObject } from "react";
import {
  CHANGES_FILES_DEFAULT_WIDTH,
  CHANGES_FILES_MIN_WIDTH,
  changesFilesMaximumWidth,
  clampChangesFilesWidth,
  clearChangesFilesWidth,
  readChangesFilesWidth,
  writeChangesFilesWidth,
} from "../changes-files-width.js";
import { useSidebarResizeDrag } from "./use-sidebar-resize-drag.js";

function bodyWidth(body: RefObject<HTMLElement | null>): number {
  return body.current?.getBoundingClientRect().width ?? window.innerWidth;
}

export function useChangesFilesWidth(body: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(() => readChangesFilesWidth());
  useEffect(() => {
    const fit = () => setWidth((current) => clampChangesFilesWidth(current, bodyWidth(body)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [body]);
  const resize = useCallback((next: number) => {
    const clamped = clampChangesFilesWidth(next, bodyWidth(body));
    setWidth(clamped);
    writeChangesFilesWidth(clamped);
  }, [body]);
  const reset = useCallback(() => {
    clearChangesFilesWidth();
    setWidth(clampChangesFilesWidth(CHANGES_FILES_DEFAULT_WIDTH, bodyWidth(body)));
  }, [body]);
  return { width, resize, reset };
}

export function ChangesFilesResizeHandle({ width, body, resize, reset, draggingChanged }: {
  width: number;
  body: RefObject<HTMLElement | null>;
  resize(width: number): void;
  reset(): void;
  draggingChanged(dragging: boolean): void;
}) {
  const { dragging, startDrag } = useSidebarResizeDrag(
    (clientX) => resize(clientX - (body.current?.getBoundingClientRect().left ?? 0)),
    draggingChanged,
  );
  const maximum = changesFilesMaximumWidth(bodyWidth(body));
  return <div
    className={`sidebar-resize-handle changes-files-resize-handle${dragging ? " dragging" : ""}`}
    role="separator"
    aria-label="Resize changed files list"
    aria-orientation="vertical"
    aria-valuemin={CHANGES_FILES_MIN_WIDTH}
    aria-valuemax={maximum}
    aria-valuenow={width}
    tabIndex={0}
    title="Drag to resize changed files · Double-click to reset"
    onDoubleClick={reset}
    onPointerDown={startDrag}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 40 : 10;
      const next = event.key === "ArrowLeft" ? width - step
        : event.key === "ArrowRight" ? width + step
          : event.key === "Home" ? CHANGES_FILES_MIN_WIDTH
            : event.key === "End" ? maximum
              : undefined;
      if (next === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      resize(next);
    }}
  />;
}
