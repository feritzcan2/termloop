// Binds the reusable Ghostty surface's bridge to `window.pm.ghostty`. One
// preload subscription per event fans out to per-surface listeners.
import type { GhosttyBridge } from "@termloop/terminal-surface/ghostty-bridge";
import type { PmGhosttyApi } from "../../pm-api.js";

type Listeners<T extends unknown[]> = Map<number, Set<(...args: T) => void>>;

function addListener<T extends unknown[]>(map: Listeners<T>, surfaceId: number, listener: (...args: T) => void): () => void {
  const listeners = map.get(surfaceId) ?? new Set();
  listeners.add(listener);
  map.set(surfaceId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) map.delete(surfaceId);
  };
}

export function createGhosttyBridge(api: PmGhosttyApi): GhosttyBridge {
  const input: Listeners<[Uint8Array]> = new Map();
  const closed: Listeners<[]> = new Map();
  api.onInput((surfaceId, data) => {
    for (const listener of input.get(surfaceId) ?? []) listener(data);
  });
  api.onClosed((surfaceId) => {
    for (const listener of closed.get(surfaceId) ?? []) listener();
  });
  return {
    create: (frame) => api.create(frame),
    write: (surfaceId, data) => api.write(surfaceId, data),
    setFrame: (surfaceId, x, y, width, height) => api.setFrame(surfaceId, { x, y, width, height }),
    setVisible: (surfaceId, visible) => api.setVisible(surfaceId, visible),
    // The PM is dark-only and the dark config is Ghostty's starting scheme.
    setColorScheme: async () => undefined,
    snapshotText: (surfaceId) => api.snapshotText(surfaceId),
    snapshotImage: (surfaceId) => api.snapshotImage(surfaceId),
    snapshotAndHide: (surfaceId) => api.snapshotAndHide(surfaceId),
    scrollToBottom: (surfaceId) => api.scrollToBottom(surfaceId),
    paste: (surfaceId, text) => api.paste(surfaceId, text),
    focus: (surfaceId) => api.focus(surfaceId),
    diagnosticText: async () => undefined,
    destroy: (surfaceId) => api.destroy(surfaceId),
    onInput: (surfaceId, listener) => addListener(input, surfaceId, listener),
    onClosed: (surfaceId, listener) => addListener(closed, surfaceId, listener),
  };
}
