import type { BrowserWindow } from "electron";
import type { GhosttyHostAddon } from "../platform/ghostty-host.js";
import type { GhosttyShellShortcut } from "../ghostty-shell-shortcut.js";
import { socketFromFd, type FdSocket } from "../platform/fd-socket.js";

export type SurfaceFrame = { x: number; y: number; width: number; height: number };

const PLACEHOLDER_SURFACE_WIDTH = 320;
const PLACEHOLDER_SURFACE_HEIGHT = 240;

type SurfaceEntry = {
  surfaceId: number;
  socket: FdSocket;
  closed: boolean;
  writes: GhosttyConsumedWriteLedger;
};

type PendingWrite = {
  remaining: number;
  resolve(): void;
  reject(error: Error): void;
};

export class GhosttyConsumedWriteLedger {
  readonly #pending: PendingWrite[] = [];

  enqueue(bytes: number): { promise: Promise<void>; reject(error: Error): void } {
    let pending!: PendingWrite;
    const promise = new Promise<void>((resolve, reject) => {
      pending = { remaining: bytes, resolve, reject };
      this.#pending.push(pending);
    });
    return {
      promise,
      reject: (error) => {
        const index = this.#pending.indexOf(pending);
        if (index >= 0) this.#pending.splice(index, 1);
        pending.reject(error);
      },
    };
  }

  consume(bytes: number): void {
    let remaining = bytes;
    while (remaining > 0) {
      const pending = this.#pending[0];
      if (!pending) return;
      const consumed = Math.min(remaining, pending.remaining);
      pending.remaining -= consumed;
      remaining -= consumed;
      if (pending.remaining === 0) {
        this.#pending.shift();
        pending.resolve();
      }
    }
  }

  rejectAll(error: Error): void {
    for (const pending of this.#pending.splice(0)) pending.reject(error);
  }
}

/// Owns native Ghostty surfaces for one BrowserWindow. Bytes written by
/// Ghostty (user input) stream off the surface socket and are forwarded
/// to the renderer, which owns the terminal attachment and its credit
/// accounting; daemon output arrives from the renderer through write().
///
/// Every method must be called on the main process (AppKit) thread —
/// Electron IPC handlers already guarantee that.
export class GhosttySurfaceManager {
  readonly #addon: GhosttyHostAddon;
  readonly #window: BrowserWindow;
  readonly #configFile: string;
  readonly #surfaces = new Map<number, SurfaceEntry>();
  #appInitialized = false;

  constructor(addon: GhosttyHostAddon, window: BrowserWindow, configFile: string) {
    this.#addon = addon;
    this.#window = window;
    this.#configFile = configFile;
  }

  /// `frame` is the pane rect the renderer is about to show this surface in.
  /// It is not cosmetic: Ghostty derives the terminal grid from the view size,
  /// and the renderer reports that grid to the daemon as the PTY size. Creating
  /// at a placeholder rect therefore resized every freshly opened Session's PTY
  /// to the placeholder's columns, let the agent repaint at that width, and
  /// then reflowed the whole screen when the real frame arrived one frame
  /// later - which is what left mis-wrapped, overlapping text on first open.
  create(frame?: SurfaceFrame): { surfaceId: number; rows: number; cols: number } {
    if (!this.#appInitialized) {
      this.#addon.initApp({
        configFile: this.#configFile,
        onSurfaceClosed: (surfaceId) => this.#surfaceClosed(surfaceId),
        onOutputConsumed: (surfaceId, bytes) => this.#outputConsumed(surfaceId, bytes),
        onShellShortcut: (shortcut) => this.#shellShortcut(shortcut),
      });
      this.#appInitialized = true;
    }
    const created = this.#addon.createSurface({
      handle: this.#window.getNativeWindowHandle(),
      x: frame?.x ?? 0,
      y: frame?.y ?? 0,
      // Only reached when the renderer has no laid-out container yet; that
      // surface stays invisible and reports no grid until its first frame.
      width: frame?.width ?? PLACEHOLDER_SURFACE_WIDTH,
      height: frame?.height ?? PLACEHOLDER_SURFACE_HEIGHT,
    });
    // Invisible until the renderer reports the real pane frame.
    this.#addon.setSurfaceVisible(created.id, false);
    const socket = socketFromFd(created.hostFd);
    socket.on("data", (chunk: Buffer) => {
      if (this.#window.isDestroyed()) return;
      this.#window.webContents.send("termloop:ghostty-input", {
        surfaceId: created.id,
        data: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
      });
    });
    const markClosed = (error = new Error("ghosttySurfaceIoClosed")) => {
      const entry = this.#surfaces.get(created.id);
      if (!entry || entry.closed) return;
      entry.closed = true;
      entry.writes.rejectAll(error);
    };
    socket.on("end", markClosed);
    socket.on("close", markClosed);
    socket.on("error", (error) => {
      markClosed(error);
      // Surface fd errors surface as missing input; the renderer-owned
      // attachment state machine reports daemon-side connection issues.
    });
    this.#surfaces.set(created.id, {
      surfaceId: created.id,
      socket,
      closed: false,
      writes: new GhosttyConsumedWriteLedger(),
    });
    return { surfaceId: created.id, rows: created.rows, cols: created.cols };
  }

  /// Writes daemon output bytes into the surface. Resolves only after the
  /// external backend reports that the same bytes have returned from
  /// Termio.processOutput, making this promise the exact output-credit cue.
  write(surfaceId: number, data: Uint8Array): Promise<void> {
    const entry = this.#surfaces.get(surfaceId);
    if (!entry || entry.closed) return Promise.reject(new Error("ghosttySurfaceClosed"));
    if (data.byteLength === 0) return Promise.resolve();
    const pending = entry.writes.enqueue(data.byteLength);
    entry.socket.write(data, (error) => {
      if (error) pending.reject(error);
    });
    return pending.promise;
  }

  setFrame(
    surfaceId: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): { rows: number; cols: number } | undefined {
    if (!this.#surfaces.has(surfaceId)) return undefined;
    return this.#addon.setSurfaceFrame(surfaceId, x, y, width, height);
  }

  setVisible(surfaceId: number, visible: boolean): void {
    if (!this.#surfaces.has(surfaceId)) return;
    this.#addon.setSurfaceVisible(surfaceId, visible);
  }

  focus(surfaceId: number): void {
    if (!this.#surfaces.has(surfaceId)) return;
    this.#addon.focusSurface(surfaceId);
  }

  probeText(surfaceId: number): string | undefined {
    if (!this.#surfaces.has(surfaceId)) return undefined;
    return this.#addon.surfaceText(surfaceId);
  }

  snapshotPng(surfaceId: number): Buffer | undefined {
    if (!this.#surfaces.has(surfaceId)) return undefined;
    return this.#addon.surfacePng(surfaceId);
  }

  /// Capture the last visible AppKit frame and hide the native view in the
  /// same main-process turn. Keeping these operations together prevents the
  /// renderer from accidentally snapshotting an already-hidden view while
  /// still releasing native pointer interception promptly.
  snapshotAndHidePng(surfaceId: number): Buffer | undefined {
    if (!this.#surfaces.has(surfaceId)) return undefined;
    try {
      return this.#addon.surfacePng(surfaceId);
    } finally {
      this.#addon.setSurfaceVisible(surfaceId, false);
    }
  }

  destroy(surfaceId: number): void {
    const entry = this.#surfaces.get(surfaceId);
    if (!entry) return;
    this.#surfaces.delete(surfaceId);
    const error = new Error("ghosttySurfaceDestroyed");
    entry.writes.rejectAll(error);
    entry.socket.destroy();
    this.#addon.destroySurface(surfaceId);
  }

  dispose(): void {
    for (const surfaceId of [...this.#surfaces.keys()]) this.destroy(surfaceId);
  }

  #surfaceClosed(surfaceId: number): void {
    const entry = this.#surfaces.get(surfaceId);
    if (!entry) return;
    entry.closed = true;
    if (!this.#window.isDestroyed()) {
      this.#window.webContents.send("termloop:ghostty-closed", { surfaceId });
    }
    this.destroy(surfaceId);
  }

  #outputConsumed(surfaceId: number, bytes: number): void {
    const entry = this.#surfaces.get(surfaceId);
    if (!entry || !Number.isSafeInteger(bytes) || bytes <= 0) return;
    entry.writes.consume(bytes);
  }

  #shellShortcut(shortcut: GhosttyShellShortcut): void {
    if (this.#window.isDestroyed()) return;
    this.#window.webContents.send("termloop:ghostty-shell-shortcut", { shortcut });
  }
}
