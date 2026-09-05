import { describe, expect, it, vi } from "vitest";

const expo = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(() => null),
}));

vi.mock("expo", () => expo);

import { clipboardBridge, createClipboardBridge } from "../src/platform/clipboard";

describe("clipboard bridge", () => {
  it("resolves the native module without making it mandatory", () => {
    expect(expo.requireOptionalNativeModule).toHaveBeenCalledWith("ExpoClipboard");
  });

  it("keeps older native builds running until copy is requested", async () => {
    await expect(clipboardBridge.copyText("session-id")).rejects.toThrow(
      "Copying requires the latest TermLoop app build",
    );
  });

  it("keeps older native builds running until image paste is requested", async () => {
    await expect(clipboardBridge.pasteImage()).rejects.toThrow(
      "Pasting images requires the latest TermLoop app build",
    );
  });

  it("copies through a native module when the binary provides one", async () => {
    const setStringAsync = vi.fn(async () => true);
    const bridge = createClipboardBridge({ setStringAsync });

    await bridge.copyText("session-id");

    expect(setStringAsync).toHaveBeenCalledWith("session-id");
  });

  it("reads a copied image only when paste is explicitly requested", async () => {
    const getImageAsync = vi.fn(async () => ({
      data: "data:image/jpeg;base64,aW1hZ2U=",
      size: { width: 1200, height: 800 },
    }));
    const bridge = createClipboardBridge({
      setStringAsync: vi.fn(async () => true),
      getImageAsync,
    });

    await expect(bridge.pasteImage()).resolves.toEqual({
      uri: "data:image/jpeg;base64,aW1hZ2U=",
      mediaType: "image/jpeg",
      width: 1200,
      height: 800,
    });
    expect(getImageAsync).toHaveBeenCalledWith({ format: "jpeg", jpegQuality: 0.88 });
  });

  it("reports an empty or unreadable copied image", async () => {
    const empty = createClipboardBridge({
      setStringAsync: vi.fn(async () => true),
      getImageAsync: vi.fn(async () => null),
    });
    const invalid = createClipboardBridge({
      setStringAsync: vi.fn(async () => true),
      getImageAsync: vi.fn(async () => ({
        data: "not-an-image",
        size: { width: 10, height: 10 },
      })),
    });

    await expect(empty.pasteImage()).resolves.toBeNull();
    await expect(invalid.pasteImage()).rejects.toThrow("copied image could not be read");
  });
});
