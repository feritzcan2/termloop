// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PmGhosttyApi } from "../src/pm-api.js";
import type { SurfaceFactory } from "../src/renderer/terminal/agent-terminal.js";
import { createGhosttyBridge } from "../src/renderer/terminal/ghostty-bridge.js";
import { watchModalOcclusion } from "../src/renderer/terminal/ghostty-surface.js";
import { selectSurfaceFactory } from "../src/renderer/terminal/surface-factory.js";

function fakeApi() {
  let input: ((surfaceId: number, data: Uint8Array) => void) | undefined;
  let closed: ((surfaceId: number) => void) | undefined;
  const api: PmGhosttyApi = {
    create: vi.fn(async () => ({ surfaceId: 3, rows: 0, cols: 0 })),
    write: vi.fn(async () => undefined),
    setFrame: vi.fn(async () => ({ rows: 33, cols: 101 })),
    setVisible: vi.fn(async () => undefined),
    focus: vi.fn(async () => undefined),
    scrollToBottom: vi.fn(async () => undefined),
    paste: vi.fn(async () => undefined),
    snapshotText: vi.fn(async () => undefined),
    snapshotImage: vi.fn(async () => undefined),
    snapshotAndHide: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    onInput: (listener) => { input = listener; return () => undefined; },
    onClosed: (listener) => { closed = listener; return () => undefined; },
  };
  return { api, input: (id: number, data: Uint8Array) => input?.(id, data), closed: (id: number) => closed?.(id) };
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

afterEach(() => { document.body.innerHTML = ""; });

describe("agent surface selection", () => {
  const xterm: SurfaceFactory = () => { throw new Error("xterm"); };

  it("uses xterm unless the preload reports the Ghostty renderer", () => {
    const { api } = fakeApi();
    expect(selectSurfaceFactory(undefined, xterm)).toBe(xterm);
    expect(selectSurfaceFactory({ terminalRenderer: "xterm", ghostty: api }, xterm)).toBe(xterm);
    expect(selectSurfaceFactory({ terminalRenderer: "ghostty", ghostty: api }, xterm)).not.toBe(xterm);
  });

  it("mounts a Ghostty surface that reports the native grid and stays hidden while a dialog is open", async () => {
    const fake = fakeApi();
    const factory = selectSurfaceFactory({ terminalRenderer: "ghostty", ghostty: fake.api }, xterm);
    const resize = vi.fn();
    const surface = factory(() => undefined, resize);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    const host = document.createElement("div");
    document.body.append(host);
    await surface.mount(host, true);
    expect(resize).toHaveBeenCalledWith(33, 101);
    await vi.waitFor(() => expect(fake.api.setVisible).toHaveBeenLastCalledWith(3, false));
    expect(fake.api.setVisible).not.toHaveBeenCalledWith(3, true);
    dialog.remove();
    await vi.waitFor(() => expect(fake.api.setVisible).toHaveBeenLastCalledWith(3, true));
    surface.dispose();
    expect(fake.api.destroy).toHaveBeenCalledWith(3);
  });
});

describe("ghostty bridge", () => {
  it("routes input and close events to the listeners of their own surface", () => {
    const fake = fakeApi();
    const bridge = createGhosttyBridge(fake.api);
    const first = vi.fn();
    const second = vi.fn();
    const closed = vi.fn();
    const stop = bridge.onInput(1, first);
    bridge.onInput(2, second);
    bridge.onClosed(2, closed);
    const bytes = new Uint8Array([104, 105]);
    fake.input(1, bytes);
    fake.closed(2);
    expect(first).toHaveBeenCalledWith(bytes);
    expect(second).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
    stop();
    fake.input(1, bytes);
    expect(first).toHaveBeenCalledOnce();
  });

  it("passes frames to main as one rect", async () => {
    const fake = fakeApi();
    await createGhosttyBridge(fake.api).setFrame(3, 1, 2, 3, 4);
    expect(fake.api.setFrame).toHaveBeenCalledWith(3, { x: 1, y: 2, width: 3, height: 4 });
  });
});

describe("modal occlusion", () => {
  it("reports dialogs opening and closing, once per change", async () => {
    const changes: boolean[] = [];
    const stop = watchModalOcclusion(document, (occluded) => changes.push(occluded));
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.append(backdrop);
    await Promise.resolve();
    document.body.append(document.createElement("span"));
    await Promise.resolve();
    backdrop.remove();
    await Promise.resolve();
    stop();
    expect(changes).toEqual([true, false]);
  });
});
