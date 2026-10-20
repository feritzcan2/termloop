import { describe, expect, it, vi } from "vitest";
import { createQuickActionImageRestore } from "../src/renderer/composition/quick-action-image-restore.js";
import type { QuickActionImageHandle } from "../src/quick-action-image.js";

const entityId = "3990a293-916f-4a24-b8f7-61cd99f783c3";
const remoteAttachmentId = `tla:6:remote${entityId}`;
const handle: QuickActionImageHandle = {
  id: remoteAttachmentId, mediaType: "image/png", byteLength: 10, sha256: `sha256:${"a".repeat(64)}`,
  width: 1, height: 1, previewDataUrl: "data:image/png;base64,AA==",
};

describe("Quick Action image restore", () => {
  it("restores a saved image that belongs to the selected Project's computer", async () => {
    const restore = vi.fn(async () => handle);
    const restoreImage = createQuickActionImageRestore({ selectedProfileId: () => "remote", restore });
    await expect(restoreImage(remoteAttachmentId)).resolves.toBe(handle);
    expect(restore).toHaveBeenCalledWith(remoteAttachmentId);
  });

  it("rejects instead of throwing when the saved image belongs to another computer", async () => {
    const restore = vi.fn(async () => handle);
    const restoreImage = createQuickActionImageRestore({ selectedProfileId: () => "local", restore });
    let result: Promise<QuickActionImageHandle> | undefined;
    expect(() => { result = restoreImage(remoteAttachmentId); }).not.toThrow();
    await expect(result).rejects.toThrow("The saved image belongs to another computer");
    expect(restore).not.toHaveBeenCalled();
  });

  it("treats a legacy unscoped image as local and rejects a source lookup failure", async () => {
    const restoreImage = createQuickActionImageRestore({
      selectedProfileId: () => "local",
      restore: () => { throw new Error("Attachment source is unavailable"); },
    });
    let result: Promise<QuickActionImageHandle> | undefined;
    expect(() => { result = restoreImage(entityId); }).not.toThrow();
    await expect(result).rejects.toThrow("Attachment source is unavailable");
  });
});
