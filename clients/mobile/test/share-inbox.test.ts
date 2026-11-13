import { describe, expect, it, vi } from "vitest";

const expo = vi.hoisted(() => ({ requireOptionalNativeModule: vi.fn(() => null) }));
vi.mock("expo", () => expo);

import { createShareInbox, validShareBatchId, type NativeShareInbox } from "../src/platform/share-inbox";

const batch = "0f8fad5b-d9cb-469f-a165-70867728950e";

function native(entry: ReturnType<NativeShareInbox["read"]>) {
  return { read: vi.fn(() => entry), remove: vi.fn() };
}

describe("share inbox", () => {
  it("accepts only a lowercase UUID batch from the share URL", () => {
    expect(validShareBatchId(batch)).toBe(true);
    expect(validShareBatchId(batch.toUpperCase())).toBe(false);
    expect(validShareBatchId("../ShareInbox")).toBe(false);
    expect(validShareBatchId(undefined)).toBe(false);
  });

  it("never passes an untrusted batch to native code", () => {
    const module = native(null);
    const inbox = createShareInbox(module);
    expect(inbox.read("../../Library")).toBeUndefined();
    inbox.remove("not-a-batch");
    expect(module.read).not.toHaveBeenCalled();
    expect(module.remove).not.toHaveBeenCalled();
  });

  it("reads a staged file image and ignores malformed native entries", () => {
    const staged = createShareInbox(native({ uri: "file:///group/ShareInbox/x/image.png", mediaType: "image/png", width: 1179, height: 2556 }));
    expect(staged.read(batch)).toEqual({ uri: "file:///group/ShareInbox/x/image.png", mediaType: "image/png", width: 1179, height: 2556 });
    expect(createShareInbox(native({ uri: "https://example.invalid/x.png", mediaType: null, width: 1, height: 1 })).read(batch)).toBeUndefined();
    expect(createShareInbox(native({ uri: "file:///x.png", mediaType: 4, width: "1", height: null })).read(batch))
      .toEqual({ uri: "file:///x.png", mediaType: null, width: 0, height: 0 });
    expect(createShareInbox(null).read(batch)).toBeUndefined();
  });
});
