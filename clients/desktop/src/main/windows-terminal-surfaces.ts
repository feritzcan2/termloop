import type { WindowsTerminalAddon, WindowsTerminalFrame } from "../platform/windows-terminal.js";

type HostWindow = { getNativeWindowHandle(): Buffer; isDestroyed(): boolean };
type HostEvents = {
  input(id: number, data: ArrayBuffer): void;
  closed(id: number): void;
  shortcut(action: string): void;
};
type Bitmap = { data: Buffer; width: number; height: number };

// Implements the existing native surface lifecycle. The legacy ghostty-named
// IPC is a transport contract reused by both native engines, not a PTY owner.
export class WindowsTerminalSurfaceManager {
  readonly #surfaces = new Map<number, TextDecoder>();
  #disposed = false;

  constructor(
    private readonly addon: WindowsTerminalAddon,
    private readonly window: HostWindow,
    private readonly events: HostEvents,
    private readonly encodePng: (bitmap: Bitmap) => Buffer,
  ) {}

  create(frame: WindowsTerminalFrame = { x: 0, y: 0, width: 320, height: 240 }) {
    if (this.#disposed || this.window.isDestroyed()) throw new Error("windowsTerminalHostClosed");
    const created = this.addon.create(this.window.getNativeWindowHandle(), frame, (kind, id, value) => {
      if (this.window.isDestroyed() || !this.#surfaces.has(id)) return;
      if (kind === "input" && value !== undefined) this.events.input(id, new TextEncoder().encode(value).buffer);
      else if (kind === "shortcut" && value !== undefined) this.events.shortcut(value);
      else if (kind === "closed") { this.events.closed(id); this.destroy(id); }
    });
    this.#surfaces.set(created.surfaceId, new TextDecoder());
    return created;
  }

  async write(id: number, data: Uint8Array): Promise<void> {
    const decoder = this.#surfaces.get(id);
    if (!decoder) throw new Error("windowsTerminalSurfaceClosed");
    if (data.byteLength > 1024 * 1024) throw new Error("windowsTerminalOutputTooLarge");
    // Preserve UTF-8 split across binary frames independently for every pane.
    const text = decoder.decode(data, { stream: true });
    if (text) this.addon.write(id, text);
    // The native call synchronously feeds the VT parser. Only now may the
    // attachment replenish output credit; no extra unbounded output queue.
  }

  setFrame(id: number, x: number, y: number, width: number, height: number) {
    if (this.#surfaces.has(id)) return this.addon.setFrame(id, x, y, width, height);
    return undefined;
  }
  setVisible(id: number, visible: boolean): void { if (this.#surfaces.has(id)) this.addon.setVisible(id, visible); }
  setColorScheme(id: number, theme: "dark" | "light"): void { if (this.#surfaces.has(id)) this.addon.setColorScheme(id, theme); }
  focus(id: number): void { if (this.#surfaces.has(id)) this.addon.focus(id); }
  scrollToBottom(id: number): void { if (this.#surfaces.has(id)) this.addon.scrollToBottom(id); }
  async probeText(id: number): Promise<string | undefined> {
    if (!this.#surfaces.has(id)) return undefined;
    const text = await this.addon.readText(id);
    return this.#surfaces.has(id) ? text : undefined;
  }
  snapshotPng(id: number): Buffer | undefined {
    if (!this.#surfaces.has(id)) return undefined;
    const bitmap = this.addon.snapshot(id);
    return bitmap ? this.encodePng(bitmap) : undefined;
  }
  snapshotAndHidePng(id: number): Buffer | undefined {
    try { return this.snapshotPng(id); }
    finally { this.setVisible(id, false); }
  }
  destroy(id: number): void {
    if (!this.#surfaces.delete(id)) return;
    this.addon.destroy(id);
  }
  dispose(): void {
    this.#disposed = true;
    for (const id of this.#surfaces.keys()) this.destroy(id);
  }
}
