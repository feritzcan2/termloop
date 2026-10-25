import { describe, expect, it, vi } from "vitest";
import { ghosttyHandlers, type GhosttySurfaces } from "../src/main/ghostty-ipc.js";
import { ghosttyHostPaths, terminalRendererFor } from "../src/platform/ghostty-host.js";
import { IPC, TERMINAL_RENDERER_ARG, terminalRendererFromArgv } from "../src/pm-api.js";

function fakeSurfaces(): GhosttySurfaces {
  return {
    create: vi.fn(() => ({ surfaceId: 7, rows: 30, cols: 90 })),
    write: vi.fn(async () => undefined),
    setFrame: vi.fn(() => ({ rows: 31, cols: 91 })),
    setVisible: vi.fn(),
    focus: vi.fn(),
    scrollToBottom: vi.fn(),
    paste: vi.fn(),
    probeText: vi.fn(() => "text"),
    snapshotPng: vi.fn(() => Buffer.from([1, 2, 3])),
    snapshotAndHidePng: vi.fn(() => undefined),
    destroy: vi.fn(),
  };
}

describe("terminal renderer selection", () => {
  it("defaults to Ghostty on macOS only, with TERMLOOP_TERMINAL_RENDERER=xterm as the kill switch", () => {
    expect(terminalRendererFor("darwin", undefined)).toBe("ghostty");
    expect(terminalRendererFor("darwin", "ghostty")).toBe("ghostty");
    expect(terminalRendererFor("darwin", "xterm")).toBe("xterm");
    expect(terminalRendererFor("linux", undefined)).toBe("xterm");
    expect(terminalRendererFor("win32", "ghostty")).toBe("xterm");
  });

  it("hands the effective renderer to the preload through one argv flag", () => {
    expect(terminalRendererFromArgv(["electron", `${TERMINAL_RENDERER_ARG}ghostty`])).toBe("ghostty");
    expect(terminalRendererFromArgv(["electron", `${TERMINAL_RENDERER_ARG}xterm`])).toBe("xterm");
    expect(terminalRendererFromArgv(["electron"])).toBe("xterm");
  });

  it("resolves the checkout addon and resources desktop uses, unless overridden", () => {
    const dev = ghosttyHostPaths("/repo/clients/pm", false, "/unused", {});
    expect(dev.addonPath).toBe("/repo/clients/ghostty-host/dist/native/ghostty_host.node");
    expect(dev.resourcesPath).toBe("/repo/vendor/ghostty/zig-out/share/ghostty");
    const overridden = ghosttyHostPaths("/repo/clients/pm", false, "/unused", { TERMLOOP_GHOSTTY_ADDON: "/a.node", GHOSTTY_RESOURCES_DIR: "/res" });
    expect(overridden).toEqual({ addonPath: "/a.node", resourcesPath: "/res" });
  });
});

describe("ghostty IPC handlers", () => {
  it("serve exactly the ghostty invoke channels and nothing else", () => {
    const channels = Object.keys(ghosttyHandlers(() => undefined)).sort();
    const expected = Object.entries(IPC)
      .filter(([name]) => name.startsWith("ghostty") && name !== "ghosttyInput" && name !== "ghosttyClosed")
      .map(([, channel]) => channel)
      .sort();
    expect(channels).toEqual(expected);
    expect(channels.every((channel) => channel.startsWith("pm:ghostty-"))).toBe(true);
  });

  it("refuses every call when main runs the xterm renderer", () => {
    const handlers = ghosttyHandlers(() => undefined);
    expect(() => handlers[IPC.ghosttyCreate]!(undefined)).toThrow("ghosttyUnavailable");
    expect(() => handlers[IPC.ghosttyFocus]!(1)).toThrow("ghosttyUnavailable");
  });

  it("validates ids, frames, bytes, visibility and paste before reaching the manager", async () => {
    const surfaces = fakeSurfaces();
    const handlers = ghosttyHandlers(() => surfaces);
    for (const id of [0, -1, 1.5, "1", undefined]) expect(() => handlers[IPC.ghosttyFocus]!(id)).toThrow("invalidGhosttySurfaceId");
    expect(() => handlers[IPC.ghosttyCreate]!({ x: 0, y: 0, width: 0, height: 10 })).toThrow("invalidGhosttySurfaceFrame");
    expect(() => handlers[IPC.ghosttySetFrame]!(1, { x: 0, y: 0, width: -1, height: 1 })).toThrow("invalidGhosttySurfaceFrame");
    expect(() => handlers[IPC.ghosttySetFrame]!(1, { x: Number.NaN, y: 0, width: 1, height: 1 })).toThrow("invalidGhosttySurfaceFrame");
    await expect(handlers[IPC.ghosttyWrite]!(1, "bytes")).rejects.toThrow("invalidGhosttySurfaceData");
    expect(() => handlers[IPC.ghosttySetVisible]!(1, "yes")).toThrow("invalidGhosttySurfaceVisibility");
    expect(() => handlers[IPC.ghosttyPaste]!(1, "")).toThrow("invalidGhosttySurfacePaste");
    expect(() => handlers[IPC.ghosttyPaste]!(1, "x".repeat(65_537))).toThrow("invalidGhosttySurfacePaste");
    expect(surfaces.focus).not.toHaveBeenCalled();
    expect(surfaces.setFrame).not.toHaveBeenCalled();
    expect(surfaces.write).not.toHaveBeenCalled();
  });

  it("forwards valid calls and returns snapshots as bounded PNG data URLs", async () => {
    const surfaces = fakeSurfaces();
    const handlers = ghosttyHandlers(() => surfaces);
    expect(handlers[IPC.ghosttyCreate]!({ x: 1, y: 2, width: 300, height: 200 })).toEqual({ surfaceId: 7, rows: 30, cols: 90 });
    expect(surfaces.create).toHaveBeenCalledWith({ x: 1, y: 2, width: 300, height: 200 });
    expect(handlers[IPC.ghosttyCreate]!(undefined)).toEqual({ surfaceId: 7, rows: 30, cols: 90 });
    expect(handlers[IPC.ghosttySetFrame]!(7, { x: 1, y: 2, width: 3, height: 4 })).toEqual({ rows: 31, cols: 91 });
    expect(surfaces.setFrame).toHaveBeenCalledWith(7, 1, 2, 3, 4);
    const bytes = new Uint8Array([65]);
    await handlers[IPC.ghosttyWrite]!(7, bytes);
    expect(surfaces.write).toHaveBeenCalledWith(7, bytes);
    expect(handlers[IPC.ghosttySnapshotImage]!(7)).toBe("data:image/png;base64,AQID");
    expect(handlers[IPC.ghosttySnapshotAndHide]!(7)).toBeUndefined();
  });
});
