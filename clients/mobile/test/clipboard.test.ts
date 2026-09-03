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

  it("copies through a native module when the binary provides one", async () => {
    const setStringAsync = vi.fn(async () => true);
    const bridge = createClipboardBridge({ setStringAsync });

    await bridge.copyText("session-id");

    expect(setStringAsync).toHaveBeenCalledWith("session-id");
  });
});
