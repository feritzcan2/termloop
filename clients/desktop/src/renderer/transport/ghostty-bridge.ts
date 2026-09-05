import { desktopApi } from "./desktop-api.js";
import { parseGhosttyShellShortcut, type GhosttyShellShortcut } from "../../ghostty-shell-shortcut.js";
import type { AppearanceTheme } from "../appearance-theme.js";

export type GhosttyGrid = { rows: number; cols: number };
export type GhosttyFrame = { x: number; y: number; width: number; height: number };

export type GhosttyBridge = {
  create(frame?: GhosttyFrame): Promise<{ surfaceId: number; rows: number; cols: number }>;
  write(surfaceId: number, data: Uint8Array): Promise<void>;
  setFrame(surfaceId: number, x: number, y: number, width: number, height: number): Promise<GhosttyGrid | undefined>;
  setVisible(surfaceId: number, visible: boolean): Promise<void>;
  setColorScheme(surfaceId: number, theme: AppearanceTheme): Promise<void>;
  snapshotText(surfaceId: number): Promise<string | undefined>;
  snapshotImage(surfaceId: number): Promise<string | undefined>;
  snapshotAndHide(surfaceId: number): Promise<string | undefined>;
  focus(surfaceId: number): Promise<void>;
  diagnosticText(surfaceId: number): Promise<string | undefined>;
  destroy(surfaceId: number): Promise<void>;
  onInput(surfaceId: number, listener: (data: Uint8Array) => void): () => void;
  onClosed(surfaceId: number, listener: () => void): () => void;
  onShellShortcut(listener: (shortcut: GhosttyShellShortcut) => void): () => void;
};

type GhosttyInputMessage =
  | { source: "termloop"; type: "ghostty-input"; surfaceId: number; data: ArrayBuffer }
  | { source: "termloop"; type: "ghostty-closed"; surfaceId: number }
  | { source: "termloop"; type: "ghostty-shell-shortcut"; shortcut: unknown };

const inputListeners = new Map<number, Set<(data: Uint8Array) => void>>();
const closedListeners = new Map<number, Set<() => void>>();
const shellShortcutListeners = new Set<(shortcut: GhosttyShellShortcut) => void>();

if (typeof window !== "undefined") {
  window.addEventListener("message", (event: MessageEvent<GhosttyInputMessage>) => {
    const message = event.data;
    if (event.source !== window || message?.source !== "termloop") return;
    if (message.type === "ghostty-shell-shortcut") {
      const shortcut = parseGhosttyShellShortcut(message.shortcut);
      if (shortcut) for (const listener of shellShortcutListeners) listener(shortcut);
      return;
    }
    if (typeof message.surfaceId !== "number") return;
    if (message.type === "ghostty-closed") {
      for (const listener of closedListeners.get(message.surfaceId) ?? []) listener();
      return;
    }
    if (message.type !== "ghostty-input" || !(message.data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(message.data);
    for (const listener of inputListeners.get(message.surfaceId) ?? []) listener(bytes);
  });
}

export const ghosttyBridge: GhosttyBridge = {
  create: (frame) => desktopApi.ghosttySurfaceCreate(frame),
  write: (surfaceId, data) => {
    const copy = data.slice();
    return desktopApi.ghosttySurfaceWrite(surfaceId, copy.buffer);
  },
  setFrame: (surfaceId, x, y, width, height) =>
    desktopApi.ghosttySurfaceSetFrame(surfaceId, x, y, width, height),
  setVisible: (surfaceId, visible) => desktopApi.ghosttySurfaceSetVisible(surfaceId, visible),
  setColorScheme: (surfaceId, theme) => desktopApi.ghosttySurfaceSetColorScheme(surfaceId, theme),
  snapshotText: (surfaceId) => desktopApi.ghosttySurfaceSnapshotText(surfaceId),
  snapshotImage: (surfaceId) => desktopApi.ghosttySurfaceSnapshotImage(surfaceId),
  snapshotAndHide: (surfaceId) => desktopApi.ghosttySurfaceSnapshotAndHide(surfaceId),
  focus: (surfaceId) => desktopApi.ghosttySurfaceFocus(surfaceId),
  diagnosticText: (surfaceId) => desktopApi.ghosttySurfaceDiagnosticText(surfaceId),
  destroy: (surfaceId) => desktopApi.ghosttySurfaceDestroy(surfaceId),
  onInput(surfaceId, listener) {
    const listeners = inputListeners.get(surfaceId) ?? new Set();
    listeners.add(listener);
    inputListeners.set(surfaceId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) inputListeners.delete(surfaceId);
    };
  },
  onClosed(surfaceId, listener) {
    const listeners = closedListeners.get(surfaceId) ?? new Set();
    listeners.add(listener);
    closedListeners.set(surfaceId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) closedListeners.delete(surfaceId);
    };
  },
  onShellShortcut(listener) {
    shellShortcutListeners.add(listener);
    return () => { shellShortcutListeners.delete(listener); };
  },
};
