import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { QuickActionImageStore } from "../src/platform/quick-action-image-store.js";
import { connectionAttachmentIdentity } from "../src/connection-scope.js";

const LOCAL_PROFILE_ID = "local";
const REMOTE_PROFILE_ID = "123e4567-e89b-42d3-a456-426614174000";

function rawAttachmentId(handleId: string): string {
  const identity = connectionAttachmentIdentity(handleId);
  if (!identity) throw new Error("expected a connection-scoped image handle");
  return identity.entityId;
}

function storedImagePath(temporaryDirectory: string, handleId: string): string {
  return path.join(
    temporaryDirectory,
    "termloop-quick-action-images",
    `${LOCAL_PROFILE_ID}--${rawAttachmentId(handleId)}`,
    "image.png",
  );
}

function uploaded(png: Uint8Array, width: number, height: number) {
  return {
    attachmentId: randomUUID(),
    mediaType: "image/png" as const,
    byteLength: png.byteLength,
    sha256: `sha256:${createHash("sha256").update(png).digest("hex")}`,
    width,
    height,
  };
}

describe("Quick Action image store", () => {
  it("keeps identical server attachment ids isolated by connection source", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "termloop-quick-action-image-test-"));
    try {
      const store = new QuickActionImageStore(temporaryDirectory);
      const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7]);
      const attachment = uploaded(png, 4, 5);
      const local = await store.stage(
        png,
        4,
        5,
        "data:image/png;base64,bG9jYWw=",
        attachment,
        LOCAL_PROFILE_ID,
      );
      const remote = await store.stage(
        png,
        4,
        5,
        "data:image/png;base64,cmVtb3Rl",
        attachment,
        REMOTE_PROFILE_ID,
      );

      expect(local.id).not.toBe(remote.id);
      await expect(store.resolve([local.id], REMOTE_PROFILE_ID))
        .rejects.toThrow("quickActionImageSelectionInvalid");
      await expect(store.resolve([remote.id], LOCAL_PROFILE_ID))
        .rejects.toThrow("quickActionImageSelectionInvalid");
      expect((await store.resolve([local.id], LOCAL_PROFILE_ID))[0]?.attachmentId)
        .toBe(attachment.attachmentId);
      expect((await store.resolve([remote.id], REMOTE_PROFILE_ID))[0]?.attachmentId)
        .toBe(attachment.attachmentId);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("stages one private PNG descriptor and detects content drift", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "termloop-quick-action-image-test-"));
    try {
      const store = new QuickActionImageStore(temporaryDirectory);
      const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
      const handle = await store.stage(png, 2, 3, "data:image/png;base64,preview", uploaded(png, 2, 3), LOCAL_PROFILE_ID);
      const [attachment] = await store.resolve([handle.id], LOCAL_PROFILE_ID);

      expect(attachment).toMatchObject({
        attachmentId: rawAttachmentId(handle.id),
        mediaType: "image/png",
        byteLength: png.byteLength,
        width: 2,
        height: 3,
        sha256: handle.sha256,
      });
      expect(attachment).not.toHaveProperty("filePath");
      const cachedPath = storedImagePath(temporaryDirectory, handle.id);
      expect(await readFile(cachedPath)).toEqual(Buffer.from(png));

      await writeFile(cachedPath, Uint8Array.from([...png, 5]));
      await expect(store.resolve([handle.id], LOCAL_PROFILE_ID)).rejects.toThrow("quickActionImageChanged");
      await store.discard(handle.id, LOCAL_PROFILE_ID);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("removes the client-local draft after the server accepts its launch", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "termloop-quick-action-image-test-"));
    try {
      const store = new QuickActionImageStore(temporaryDirectory);
      const png = Uint8Array.from([1, 2, 3]);
      const handle = await store.stage(png, 1, 1, "data:image/png;base64,preview", uploaded(png, 1, 1), LOCAL_PROFILE_ID);
      await store.resolve([handle.id], LOCAL_PROFILE_ID);
      await store.discardAfterLaunch([handle.id], LOCAL_PROFILE_ID);
      await expect(store.resolve([handle.id], LOCAL_PROFILE_ID)).rejects.toThrow("quickActionImageNotFound");
      await expect(readFile(storedImagePath(temporaryDirectory, handle.id)))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("restores a staged draft from its private metadata after a process restart", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "termloop-quick-action-image-test-"));
    try {
      const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 8, 7, 6]);
      const staged = await new QuickActionImageStore(temporaryDirectory)
        .stage(png, 12, 9, "data:image/png;base64,cHJldmlldw==", uploaded(png, 12, 9), LOCAL_PROFILE_ID);

      const restoredStore = new QuickActionImageStore(temporaryDirectory);
      expect(await restoredStore.restore(staged.id, LOCAL_PROFILE_ID)).toEqual(staged);
      expect((await restoredStore.resolve([staged.id], LOCAL_PROFILE_ID))[0]).toMatchObject({
        attachmentId: rawAttachmentId(staged.id),
        byteLength: png.byteLength,
        width: 12,
        height: 9,
      });
      const restartedAgain = new QuickActionImageStore(temporaryDirectory);
      await restartedAgain.discard(staged.id, LOCAL_PROFILE_ID);
      await expect(restartedAgain.restore(staged.id, LOCAL_PROFILE_ID)).rejects.toThrow("quickActionImageNotFound");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("expires staged drafts and removes their private files after 24 hours", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "termloop-quick-action-image-test-"));
    try {
      const store = new QuickActionImageStore(temporaryDirectory);
      const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
      const staged = await store.stage(
        png,
        8,
        6,
        "data:image/png;base64,cHJldmlldw==",
        uploaded(png, 8, 6),
        LOCAL_PROFILE_ID,
      );
      const attachmentDirectory = path.join(
        temporaryDirectory,
        "termloop-quick-action-images",
        `${LOCAL_PROFILE_ID}--${rawAttachmentId(staged.id)}`,
      );
      const expiredAt = new Date(Date.now() - (25 * 60 * 60 * 1_000));
      await utimes(path.join(attachmentDirectory, "image.png"), expiredAt, expiredAt);
      await utimes(path.join(attachmentDirectory, "draft.json"), expiredAt, expiredAt);

      await expect(store.resolve([staged.id], LOCAL_PROFILE_ID)).rejects.toThrow("quickActionImageNotFound");
      await expect(readFile(path.join(attachmentDirectory, "image.png"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(attachmentDirectory, "draft.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(new QuickActionImageStore(temporaryDirectory).restore(staged.id, LOCAL_PROFILE_ID))
        .rejects.toThrow("quickActionImageNotFound");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
