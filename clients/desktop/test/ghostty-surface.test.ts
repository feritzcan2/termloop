import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhosttySurface } from "../src/renderer/terminal/ghostty/ghostty-surface.js";
import type { GhosttyBridge } from "../src/renderer/transport/ghostty-bridge.js";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/// The native surface derives its grid from the rect it is created at, so the
/// fake mirrors that: a creation without a pane rect can only report the
/// placeholder grid, and one with a rect already reports the pane's own grid.
function fakeBridge(created?: Promise<{ surfaceId: number; rows: number; cols: number }>) {
  const listeners = new Map<number, (data: Uint8Array) => void>();
  const closedListeners = new Map<number, () => void>();
  const bridge: GhosttyBridge = {
    create: vi.fn((frame) => created
      ?? Promise.resolve(frame
        ? { surfaceId: 7, rows: 30, cols: 100 }
        : { surfaceId: 7, rows: 24, cols: 80 })),
    write: vi.fn(async () => {}),
    setFrame: vi.fn(async () => ({ rows: 30, cols: 100 })),
    setVisible: vi.fn(async () => {}),
    setColorScheme: vi.fn(async () => {}),
    snapshotText: vi.fn(async () => "native screen"),
    snapshotImage: vi.fn(async () => undefined),
    snapshotAndHide: vi.fn(async () => undefined),
    focus: vi.fn(async () => {}),
    diagnosticText: vi.fn(async () => "native screen"),
    destroy: vi.fn(async () => {}),
    onInput: vi.fn((id, listener) => {
      listeners.set(id, listener);
      return () => listeners.delete(id);
    }),
    onClosed: vi.fn((id, listener) => {
      closedListeners.set(id, listener);
      return () => closedListeners.delete(id);
    }),
    onShellShortcut: vi.fn(() => () => {}),
  };
  return { bridge, listeners, closedListeners };
}

let animationFrames: FrameRequestCallback[];

beforeEach(() => {
  animationFrames = [];
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(_callback: ResizeObserverCallback) {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

const container = () => ({
  getBoundingClientRect: () => ({ x: 10, y: 20, width: 640, height: 480 }),
}) as HTMLElement;

describe("GhosttySurface", () => {
  it("applies the selected appearance to a native surface", async () => {
    const { bridge } = fakeBridge();
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    surface.setAppearanceTheme("light");
    await surface.mount(container(), false);
    expect(bridge.setColorScheme).toHaveBeenCalledWith(7, "light");

    surface.setAppearanceTheme("dark");
    expect(bridge.setColorScheme).toHaveBeenLastCalledWith(7, "dark");
  });

  it("queues writes before creation and preserves callback order", async () => {
    const created = deferred<{ surfaceId: number; rows: number; cols: number }>();
    const { bridge } = fakeBridge(created.promise);
    const callbacks: number[] = [];
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    surface.write(new Uint8Array([1]), () => callbacks.push(1));
    surface.write(new Uint8Array([2]), () => callbacks.push(2));

    expect(bridge.write).not.toHaveBeenCalled();
    created.resolve({ surfaceId: 7, rows: 24, cols: 80 });
    await flush();

    expect(bridge.write).toHaveBeenNthCalledWith(1, 7, new Uint8Array([1]));
    expect(bridge.write).toHaveBeenNthCalledWith(2, 7, new Uint8Array([2]));
    expect(callbacks).toEqual([1, 2]);
  });

  it("creates at the pane rect and reports that one grid, then hides on unmount", async () => {
    const { bridge } = fakeBridge();
    const resizes: Array<[number, number]> = [];
    const surface = new GhosttySurface(() => {}, (rows, cols) => resizes.push([rows, cols]), bridge);
    await surface.mount(container(), false);
    animationFrames.splice(0).forEach((callback) => callback(0));
    await flush();
    animationFrames.splice(0).forEach((callback) => callback(0));
    await flush();

    expect(bridge.create).toHaveBeenCalledWith({ x: 10, y: 20, width: 640, height: 480 });
    expect(bridge.setFrame).toHaveBeenCalledWith(7, 10, 20, 640, 480);
    expect(vi.mocked(bridge.setFrame).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(bridge.setVisible).mock.invocationCallOrder[0]!,
    );
    // One grid, so the Session's PTY is never sized to a placeholder pane and
    // the agent never repaints for a width the surface will not keep.
    expect(resizes).toEqual([[30, 100]]);
    surface.unmount();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(7, false);
  });

  it("never reports the grid of a surface created before its pane was laid out", async () => {
    const { bridge } = fakeBridge();
    const resizes: Array<[number, number]> = [];
    const surface = new GhosttySurface(() => {}, (rows, cols) => resizes.push([rows, cols]), bridge);

    surface.write(new Uint8Array([1]), () => {});
    await flush();

    expect(bridge.create).toHaveBeenCalledWith(undefined);
    expect(resizes).toEqual([]);

    surface.mount(container(), false);
    await flush();
    animationFrames.splice(0).forEach((callback) => callback(0));
    await flush();

    expect(resizes).toEqual([[30, 100]]);
  });

  it("destroys a created native surface on dispose", async () => {
    const { bridge } = fakeBridge();
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    surface.mount(container(), false);
    await flush();
    surface.dispose();
    expect(bridge.destroy).toHaveBeenCalledWith(7);
  });

  it("reads diagnostic text from the real native surface boundary", async () => {
    const { bridge } = fakeBridge();
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    surface.mount(container(), false);
    await flush();

    await expect(surface.diagnosticText()).resolves.toBe("native screen");
    expect(bridge.diagnosticText).toHaveBeenCalledWith(7);
  });

  it("keeps a transient native text snapshot behind shell overlays", async () => {
    const { bridge } = fakeBridge();
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    let snapshot: { className: string; textContent: string; setAttribute(): void; remove(): void } | undefined;
    const host = {
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 640, height: 480 }),
      append: (child: typeof snapshot) => { snapshot = child; },
      querySelector: () => snapshot,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      createElement: () => ({
        className: "",
        textContent: "",
        setAttribute: vi.fn(),
        remove: () => { snapshot = undefined; },
      }),
    });
    surface.mount(host, false);
    await flush();

    surface.setVisible(false);
    await flush();
    expect(bridge.snapshotAndHide).toHaveBeenCalledWith(7);
    expect(bridge.snapshotText).toHaveBeenCalledWith(7);
    expect(snapshot?.textContent).toBe("native screen");

    surface.setVisible(true);
    await flush();
    expect(snapshot).toBeUndefined();
  });

  it("synchronizes the live pane frame before revealing a hidden native surface", async () => {
    const { bridge } = fakeBridge();
    const revealFrame = deferred<{ rows: number; cols: number }>();
    let snapshot: { className: string; textContent: string; setAttribute(): void; remove(): void } | undefined;
    const host = {
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 640, height: 480 }),
      append: (child: typeof snapshot) => { snapshot = child; },
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      createElement: () => ({
        className: "",
        textContent: "",
        setAttribute: vi.fn(),
        remove: () => { snapshot = undefined; },
      }),
    });
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    await surface.mount(host, false);
    vi.mocked(bridge.setFrame).mockClear();
    vi.mocked(bridge.setVisible).mockClear();

    surface.setVisible(false);
    await flush();
    expect(snapshot?.textContent).toBe("native screen");

    vi.mocked(bridge.setFrame).mockReturnValueOnce(revealFrame.promise);
    surface.setVisible(true);
    expect(snapshot?.textContent).toBe("native screen");
    expect(bridge.setVisible).not.toHaveBeenCalledWith(7, true);

    revealFrame.resolve({ rows: 30, cols: 100 });
    await flush();

    expect(bridge.setFrame).toHaveBeenCalledWith(7, 10, 20, 640, 480);
    expect(bridge.setVisible).toHaveBeenCalledWith(7, true);
    expect(vi.mocked(bridge.setFrame).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(bridge.setVisible).mock.invocationCallOrder.at(-1)!,
    );
    expect(snapshot).toBeUndefined();
  });

  it("captures the visible frame and hides through one ordered bridge operation", async () => {
    const { bridge } = fakeBridge();
    const image = deferred<string | undefined>();
    vi.mocked(bridge.snapshotAndHide).mockReturnValue(image.promise);
    let snapshot: { className: string; src: string; setAttribute(): void; remove(): void } | undefined;
    const host = {
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 640, height: 480 }),
      append: (child: typeof snapshot) => { snapshot = child; },
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      createElement: () => ({
        className: "",
        src: "",
        setAttribute: vi.fn(),
        remove: () => { snapshot = undefined; },
      }),
    });
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    surface.mount(host, false);
    await flush();
    vi.mocked(bridge.setVisible).mockClear();

    surface.setVisible(false);
    await flush();

    expect(bridge.snapshotAndHide).toHaveBeenCalledWith(7);
    expect(bridge.snapshotImage).not.toHaveBeenCalled();
    expect(bridge.setVisible).not.toHaveBeenCalledWith(7, false);

    image.resolve("data:image/png;base64,AQID");
    await flush();

    expect(snapshot?.src).toBe("data:image/png;base64,AQID");
    expect(bridge.setVisible).toHaveBeenCalledWith(7, false);
  });

  it("uses a portable data URL for pixel snapshots rendered in the child overlay", async () => {
    const { bridge } = fakeBridge();
    const dataUrl = "data:image/png;base64,AQID";
    vi.mocked(bridge.snapshotAndHide).mockResolvedValue(dataUrl);
    let snapshot: { className: string; src: string; setAttribute(): void; remove(): void } | undefined;
    const host = {
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 640, height: 480 }),
      append: (child: typeof snapshot) => { snapshot = child; },
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      createElement: () => ({
        className: "",
        src: "",
        setAttribute: vi.fn(),
        remove: () => { snapshot = undefined; },
      }),
    });
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    surface.mount(host, false);
    await flush();

    surface.setVisible(false);
    await flush();

    expect(snapshot?.src).toBe(dataUrl);
    expect(bridge.snapshotText).not.toHaveBeenCalled();
  });

  it("retains the last native frame before a TUI leaves the alternate screen", async () => {
    const { bridge } = fakeBridge();
    const visibleFrame = "data:image/png;base64,VISIBLE";
    vi.mocked(bridge.snapshotImage).mockResolvedValue(visibleFrame);
    let snapshot: { className: string; src: string; setAttribute(): void; remove(): void } | undefined;
    const host = {
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 640, height: 480 }),
      append: (child: typeof snapshot) => { snapshot = child; },
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      createElement: () => ({
        className: "",
        src: "",
        setAttribute: vi.fn(),
        remove: () => { snapshot = undefined; },
      }),
    });
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    surface.mount(host, false);
    await flush();

    surface.write(new TextEncoder().encode("\u001b[?1049"), () => {});
    surface.write(new TextEncoder().encode("lreturned to an empty normal screen"), () => {});
    await flush();

    expect(vi.mocked(bridge.snapshotImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bridge.snapshotImage).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(bridge.write).mock.invocationCallOrder[1]!);

    vi.mocked(bridge.snapshotImage).mockResolvedValue("data:image/png;base64,EMPTY");
    surface.setVisible(false);
    await flush();

    expect(snapshot?.src).toBe(visibleFrame);
    expect(vi.mocked(bridge.snapshotImage)).toHaveBeenCalledTimes(1);
  });

  it("always releases write callbacks when creation fails", async () => {
    const { bridge } = fakeBridge(Promise.reject(new Error("native unavailable")));
    const callbacks: number[] = [];
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    surface.write(new Uint8Array([1]), () => callbacks.push(1));
    surface.write(new Uint8Array([2]), () => callbacks.push(2));
    await flush();
    expect(callbacks).toEqual([1, 2]);
    expect(bridge.write).not.toHaveBeenCalled();
  });

  it("stops native writes and still releases credit after external IO closes", async () => {
    const { bridge, closedListeners } = fakeBridge();
    const callbacks: number[] = [];
    const surface = new GhosttySurface(() => {}, () => {}, bridge);
    surface.mount(container(), false);
    await flush();
    closedListeners.get(7)?.();
    surface.write(new Uint8Array([9]), () => callbacks.push(1));
    await flush();
    expect(bridge.write).not.toHaveBeenCalled();
    expect(callbacks).toEqual([1]);
  });
});
