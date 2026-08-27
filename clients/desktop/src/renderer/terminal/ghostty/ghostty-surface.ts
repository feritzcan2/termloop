import type { GhosttyBridge, GhosttyFrame, GhosttyGrid } from "../../transport/ghostty-bridge.js";
import type { TerminalBufferProbe, TerminalSurface } from "../surface.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ALTERNATE_SCREEN_SEQUENCES = ["\u001b[?47", "\u001b[?1047", "\u001b[?1049"] as const;

function alternateScreenTransition(output: string): "enter" | "leave" | undefined {
  let latest: { index: number; transition: "enter" | "leave" } | undefined;
  for (const sequence of ALTERNATE_SCREEN_SEQUENCES) {
    for (const transition of ["enter", "leave"] as const) {
      const suffix = transition === "enter" ? "h" : "l";
      const index = output.lastIndexOf(`${sequence}${suffix}`);
      if (index >= 0 && (!latest || index > latest.index)) latest = { index, transition };
    }
  }
  return latest?.transition;
}

export class GhosttySurface implements TerminalSurface {
  #container: HTMLElement | undefined;
  #surfaceId: number | undefined;
  #createPromise: Promise<number | undefined> | undefined;
  #failed = false;
  #disposed = false;
  #visible = false;
  #resizeObserver: ResizeObserver | undefined;
  #frameRequest: number | undefined;
  #removeInputListener: (() => void) | undefined;
  #removeClosedListener: (() => void) | undefined;
  #writeTail: Promise<void> = Promise.resolve();
  #grid: GhosttyGrid | undefined;
  #visibilityRevision = 0;
  #snapshot: HTMLElement | undefined;
  #retainedAlternateScreenImage: string | undefined;
  #terminalSequenceTail = "";

  constructor(
    private readonly onInput: (data: string | Uint8Array) => void,
    private readonly onResize: (rows: number, cols: number) => void,
    private readonly bridge: GhosttyBridge,
  ) {}

  async mount(container: HTMLElement, _preferWebgl: boolean): Promise<void> {
    if (this.#disposed) return;
    this.#container = container;
    this.#visible = true;
    this.#installGeometryTracking();
    const surfaceId = await this.#ensureCreated();
    if (!surfaceId || container !== this.#container) return;
    // Keep the native view hidden until one post-creation frame sync has
    // measured the fully laid-out pane. TerminalPool awaits this mount before
    // opening attachment replay, so the first provider repaint and replay use
    // the same PTY grid instead of relying on a later manual window resize.
    await this.#syncFrame();
    if (container !== this.#container) return;
    await this.bridge.setVisible(surfaceId, this.#visible).catch(() => {});
    this.#scheduleFrame();
  }

  unmount(): void {
    ++this.#visibilityRevision;
    this.#removeSnapshot();
    this.#visible = false;
    this.#container = undefined;
    this.#removeGeometryTracking();
    if (this.#surfaceId) void this.bridge.setVisible(this.#surfaceId, false);
  }

  setVisible(visible: boolean): void {
    this.#visible = visible && this.#container !== undefined;
    const revision = ++this.#visibilityRevision;
    if (!this.#surfaceId) return;
    if (this.#visible) {
      this.#removeSnapshot();
      void this.bridge.setVisible(this.#surfaceId, true);
      return;
    }
    const surfaceId = this.#surfaceId;
    // Native Ghostty views are AppKit children and always paint above the web
    // contents. The main process captures the visible frame and hides the view
    // in one ordered turn, preserving overlay pixels without leaving the native
    // view around to intercept a Session drag over a DOM terminal drop target.
    void this.#installSnapshot(surfaceId, revision).finally(() => {
      if (revision === this.#visibilityRevision && !this.#visible) {
        void this.bridge.setVisible(surfaceId, false);
      }
    });
  }

  write(data: Uint8Array, callback: () => void): void {
    const bytes = data.slice();
    this.#writeTail = this.#writeTail.then(async () => {
      const surfaceId = await this.#ensureCreated();
      if (!surfaceId || this.#failed || this.#disposed) return;
      const output = `${this.#terminalSequenceTail}${decoder.decode(bytes)}`;
      const transition = alternateScreenTransition(output);
      this.#terminalSequenceTail = output.slice(-16);
      if (transition === "enter") this.#retainedAlternateScreenImage = undefined;
      if (transition === "leave") await this.#retainAlternateScreen(surfaceId);
      await this.bridge.write(surfaceId, bytes);
    }).catch(() => {
      this.#failed = true;
    }).finally(callback);
  }

  writeln(message: string): void {
    this.write(encoder.encode(`\r\n${message}\r\n`), () => {});
  }

  focus(): void {
    if (this.#surfaceId) {
      void this.bridge.focus(this.#surfaceId);
    } else {
      void this.#ensureCreated().then((surfaceId) => {
        if (surfaceId) return this.bridge.focus(surfaceId);
      });
    }
  }

  probe(): TerminalBufferProbe | undefined {
    return undefined;
  }

  diagnosticText(): Promise<string | undefined> {
    return this.#surfaceId ? this.bridge.diagnosticText(this.#surfaceId) : Promise.resolve(undefined);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.unmount();
    this.#removeSnapshot();
    this.#disposed = true;
    const surfaceId = this.#surfaceId;
    this.#removeInputListener?.();
    this.#removeInputListener = undefined;
    this.#removeClosedListener?.();
    this.#removeClosedListener = undefined;
    this.#retainedAlternateScreenImage = undefined;
    this.#terminalSequenceTail = "";
    if (surfaceId) void this.bridge.destroy(surfaceId);
  }

  #removeSnapshot(): void {
    this.#snapshot?.remove();
    this.#snapshot = undefined;
  }

  async #installSnapshot(surfaceId: number, revision: number): Promise<void> {
    let image = this.#retainedAlternateScreenImage;
    if (!image) {
      try {
        image = await this.bridge.snapshotAndHide(surfaceId);
      } catch {}
    }
    if (revision !== this.#visibilityRevision || this.#visible || !this.#container) return;

    if (image?.startsWith("data:image/png;base64,")) {
      this.#removeSnapshot();
      const snapshot = document.createElement("img");
      snapshot.className = "terminal-native-snapshot terminal-native-snapshot-image";
      snapshot.setAttribute("aria-hidden", "true");
      snapshot.src = image;
      this.#container.append(snapshot);
      this.#snapshot = snapshot;
      return;
    }

    let text: string | undefined;
    try {
      text = await this.bridge.snapshotText(surfaceId);
    } catch {}
    if (revision !== this.#visibilityRevision || this.#visible || !this.#container || !text) return;
    this.#removeSnapshot();
    const snapshot = document.createElement("pre");
    snapshot.className = "terminal-native-snapshot";
    snapshot.setAttribute("aria-hidden", "true");
    snapshot.textContent = text;
    this.#container.append(snapshot);
    this.#snapshot = snapshot;
  }

  async #retainAlternateScreen(surfaceId: number): Promise<void> {
    try {
      const image = await this.bridge.snapshotImage(surfaceId);
      if (image?.startsWith("data:image/png;base64,")) {
        this.#retainedAlternateScreenImage = image;
      }
    } catch {}
  }

  /// The pane rect this surface will occupy, once the container is laid out.
  /// Ghostty derives the terminal grid from the view size and Core takes that
  /// grid as the PTY size, so a surface created at a placeholder rect resizes
  /// the Session's PTY twice - once to the placeholder's columns and again one
  /// frame later - and the agent's repaint for the first width is what stays on
  /// screen as mis-wrapped, overlapping text until something forces a redraw.
  #containerFrame(): GhosttyFrame | undefined {
    const rect = this.#container?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  async #ensureCreated(): Promise<number | undefined> {
    if (this.#disposed || this.#failed) return undefined;
    const frame = this.#containerFrame();
    this.#createPromise ??= this.bridge.create(frame).then((created) => {
      if (this.#disposed) {
        void this.bridge.destroy(created.surfaceId);
        return undefined;
      }
      this.#surfaceId = created.surfaceId;
      this.#removeInputListener = this.bridge.onInput(created.surfaceId, this.onInput);
      this.#removeClosedListener = this.bridge.onClosed(created.surfaceId, () => {
        this.#failed = true;
        this.#removeInputListener?.();
        this.#removeInputListener = undefined;
      });
      // Only a grid measured from the real pane may reach Core. A placeholder
      // creation stays unreported; the first frame sync supplies the grid.
      if (frame) this.#updateGrid(created);
      return created.surfaceId;
    }).catch(() => {
      this.#failed = true;
      return undefined;
    });
    return this.#createPromise;
  }

  #installGeometryTracking(): void {
    this.#removeGeometryTracking();
    if (!this.#container) return;
    this.#resizeObserver = new ResizeObserver(() => this.#scheduleFrame());
    this.#resizeObserver.observe(this.#container);
    window.addEventListener("resize", this.#scheduleFrame, true);
    window.addEventListener("scroll", this.#scheduleFrame, true);
    this.#scheduleFrame();
  }

  #removeGeometryTracking(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    window.removeEventListener("resize", this.#scheduleFrame, true);
    window.removeEventListener("scroll", this.#scheduleFrame, true);
    if (this.#frameRequest !== undefined) cancelAnimationFrame(this.#frameRequest);
    this.#frameRequest = undefined;
  }

  #scheduleFrame = (): void => {
    if (this.#frameRequest !== undefined || !this.#container) return;
    this.#frameRequest = requestAnimationFrame(() => {
      this.#frameRequest = undefined;
      void this.#syncFrame();
    });
  };

  async #syncFrame(): Promise<void> {
    const container = this.#container;
    const surfaceId = await this.#ensureCreated();
    if (!container || !surfaceId || container !== this.#container) return;
    const rect = container.getBoundingClientRect();
    const grid = await this.bridge.setFrame(surfaceId, rect.x, rect.y, rect.width, rect.height).catch(() => undefined);
    if (grid) this.#updateGrid(grid);
  }

  #updateGrid(grid: GhosttyGrid): void {
    if (grid.rows <= 0 || grid.cols <= 0 ||
        (this.#grid?.rows === grid.rows && this.#grid.cols === grid.cols)) return;
    this.#grid = { rows: grid.rows, cols: grid.cols };
    this.onResize(grid.rows, grid.cols);
  }
}
