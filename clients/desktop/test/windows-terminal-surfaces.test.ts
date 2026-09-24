import { describe, expect, it, vi } from "vitest";
import { WindowsTerminalSurfaceManager } from "../src/main/windows-terminal-surfaces.js";
import type { WindowsTerminalAddon, WindowsTerminalEvent } from "../src/platform/windows-terminal.js";

function fixture() {
  let nextId = 0;
  const listeners = new Map<number, (kind: WindowsTerminalEvent, id: number, value?: string) => void>();
  const addon: WindowsTerminalAddon = {
    initialize: vi.fn(),
    create: vi.fn((_handle, _frame, listener) => {
      const surfaceId = ++nextId;
      listeners.set(surfaceId, listener);
      return { surfaceId, rows: 24, cols: 80 };
    }),
    write: vi.fn(), setFrame: vi.fn(), setVisible: vi.fn(), setColorScheme: vi.fn(),
    focus: vi.fn(), scrollToBottom: vi.fn(), readText: vi.fn(async () => "contents"),
    snapshot: vi.fn(() => ({ data: Buffer.alloc(4), width: 1, height: 1 })), destroy: vi.fn(),
  };
  const events = { input: vi.fn(), closed: vi.fn(), shortcut: vi.fn() };
  const window = { getNativeWindowHandle: () => Buffer.alloc(8), isDestroyed: () => false };
  const encodePng = vi.fn(() => Buffer.from("png"));
  return { addon, events, listeners, encodePng, manager: new WindowsTerminalSurfaceManager(addon, window, events, encodePng) };
}

describe("Windows Terminal surfaces", () => {
  it("uses the measured pane frame on first creation", () => {
    const { manager, addon } = fixture();
    const frame = { x: 150, y: 60, width: 800, height: 450 };
    manager.create(frame);
    expect(addon.create).toHaveBeenCalledWith(Buffer.alloc(8), frame, expect.any(Function));
  });

  it("preserves split UTF-8 independently for interleaved panes", async () => {
    const { manager, addon } = fixture();
    const first = manager.create().surfaceId;
    const second = manager.create().surfaceId;
    const emoji = new TextEncoder().encode("😀");
    await manager.write(first, emoji.slice(0, 2));
    await manager.write(second, new TextEncoder().encode("Türkçe"));
    await manager.write(first, emoji.slice(2));
    expect(addon.write).toHaveBeenNthCalledWith(1, second, "Türkçe");
    expect(addon.write).toHaveBeenNthCalledWith(2, first, "😀");
  });

  it("grants credit only after native consumption and propagates failures", async () => {
    const { manager, addon } = fixture();
    const id = manager.create().surfaceId;
    vi.mocked(addon.write).mockImplementation(() => { throw new Error("native failure"); });
    await expect(manager.write(id, new Uint8Array([65]))).rejects.toThrow("native failure");
    vi.mocked(addon.write).mockImplementation(() => {});
    await expect(manager.write(id, new Uint8Array([66]))).resolves.toBeUndefined();
    await expect(manager.write(id, new Uint8Array(1024 * 1024 + 1))).rejects.toThrow("OutputTooLarge");
  });

  it("captures before hiding, and still hides on capture failure", () => {
    const { manager, addon, encodePng } = fixture();
    const id = manager.create().surfaceId;
    expect(manager.snapshotAndHidePng(id)).toEqual(Buffer.from("png"));
    expect(encodePng).toHaveBeenCalledOnce();
    expect(vi.mocked(addon.snapshot).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(addon.setVisible).mock.invocationCallOrder[0]!);
    vi.mocked(addon.snapshot).mockImplementation(() => { throw new Error("capture failed"); });
    expect(() => manager.snapshotAndHidePng(id)).toThrow("capture failed");
    expect(addon.setVisible).toHaveBeenLastCalledWith(id, false);
  });

  it("routes input to its pane and rejects late events after disposal", async () => {
    const { manager, events, listeners, addon } = fixture();
    const id = manager.create().surfaceId;
    listeners.get(id)!("input", id, "ş");
    expect(events.input).toHaveBeenCalledWith(id, new TextEncoder().encode("ş").buffer);
    listeners.get(id)!("closed", id);
    expect(events.closed).toHaveBeenCalledWith(id);
    expect(addon.destroy).toHaveBeenCalledOnce();
    listeners.get(id)!("input", id, "late");
    expect(events.input).toHaveBeenCalledOnce();
    await expect(manager.write(id, new Uint8Array([65]))).rejects.toThrow("SurfaceClosed");
    manager.dispose();
    expect(() => manager.create()).toThrow("HostClosed");
  });

  it("discards readback that completes after a surface is destroyed", async () => {
    const { manager, addon } = fixture();
    const id = manager.create().surfaceId;
    let finish!: (text: string) => void;
    vi.mocked(addon.readText).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const result = manager.probeText(id);
    manager.destroy(id);
    finish("stale");
    expect(await result).toBeUndefined();
  });
});
