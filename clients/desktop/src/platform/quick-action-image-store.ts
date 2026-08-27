import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { QuickActionImageAttachment } from "@termloop/contract/current";
import type { QuickActionImageHandle } from "../quick-action-image.js";
import {
  connectionAttachmentIdentity,
  connectionAttachmentKey,
} from "../connection-scope.js";

export const QUICK_ACTION_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const QUICK_ACTION_IMAGE_MAX_DIMENSION = 16_384;
const QUICK_ACTION_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const IMAGE_DIRECTORY_NAME = "termloop-quick-action-images";
const IMAGE_METADATA_NAME = "draft.json";
const IMAGE_METADATA_MAX_BYTES = 2 * 1024 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RAW_ATTACHMENT_ID = new RegExp(`^${UUID}$`, "u");
const PROFILE_ID = new RegExp(`^(?:local|${UUID})$`, "u");
const OWNED_ATTACHMENT_DIRECTORY = new RegExp(`^(?:local|${UUID})--${UUID}$`, "u");
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

type StoredImage = {
  profileId: string;
  handle: QuickActionImageHandle;
  attachment: QuickActionImageAttachment;
  filePath: string;
};

type StoredImageMetadata = Omit<StoredImage, "filePath">;

export class QuickActionImageStore {
  readonly #directory: string;
  readonly #images = new Map<string, StoredImage>();

  constructor(temporaryDirectory: string) {
    this.#directory = path.join(temporaryDirectory, IMAGE_DIRECTORY_NAME);
  }

  async stage(
    png: Uint8Array,
    width: number,
    height: number,
    previewDataUrl: string,
    attachment: QuickActionImageAttachment,
    profileId: string,
  ): Promise<QuickActionImageHandle> {
    if (png.byteLength === 0 || png.byteLength > QUICK_ACTION_IMAGE_MAX_BYTES) {
      throw new Error("quickActionImageTooLarge");
    }
    if (!Number.isInteger(width) || width < 1 || width > QUICK_ACTION_IMAGE_MAX_DIMENSION
      || !Number.isInteger(height) || height < 1 || height > QUICK_ACTION_IMAGE_MAX_DIMENSION) {
      throw new Error("quickActionImageDimensionsInvalid");
    }
    await this.#prepareDirectory();
    await this.#removeExpiredFiles();
    const attachmentId = attachment.attachmentId;
    if (!PROFILE_ID.test(profileId)
      || !RAW_ATTACHMENT_ID.test(attachmentId)
      || attachment.mediaType !== "image/png"
      || attachment.byteLength !== png.byteLength
      || attachment.width !== width
      || attachment.height !== height) {
      throw new Error("quickActionImageUploadInvalid");
    }
    const id = connectionAttachmentKey(profileId, attachmentId);
    const attachmentDirectory = path.join(this.#directory, directoryName(profileId, attachmentId));
    const filePath = path.join(attachmentDirectory, "image.png");
    const metadataPath = path.join(attachmentDirectory, IMAGE_METADATA_NAME);
    const sha256 = `sha256:${createHash("sha256").update(png).digest("hex")}`;
    if (attachment.sha256 !== sha256) throw new Error("quickActionImageUploadInvalid");
    const handle: QuickActionImageHandle = {
      id,
      mediaType: "image/png",
      byteLength: png.byteLength,
      sha256,
      width,
      height,
      previewDataUrl,
    };
    await mkdir(attachmentDirectory, { mode: 0o700 });
    try {
      await writeFile(filePath, png, { flag: "wx", mode: 0o600 });
      await writeFile(metadataPath, JSON.stringify({ profileId, handle, attachment }), { flag: "wx", mode: 0o600 });
    } catch (cause) {
      await unlink(metadataPath).catch(() => undefined);
      await unlink(filePath).catch(() => undefined);
      await rmdir(attachmentDirectory).catch(() => undefined);
      throw cause;
    }
    this.#images.set(id, {
      profileId,
      handle,
      attachment: { ...attachment },
      filePath,
    });
    return handle;
  }

  async restore(id: string, expectedProfileId: string): Promise<QuickActionImageHandle> {
    const identity = imageIdentity(id);
    if (!identity || identity.profileId !== expectedProfileId) throw new Error("quickActionImageNotFound");
    const scopedId = connectionAttachmentKey(identity.profileId, identity.attachmentId);
    await this.#prepareDirectory();
    await this.#removeExpiredFiles();
    const current = this.#images.get(id) ?? this.#images.get(scopedId);
    if (current) {
      await verifyStoredImage(current);
      return { ...current.handle };
    }
    let attachmentDirectory = path.join(
      this.#directory,
      directoryName(identity.profileId, identity.attachmentId),
    );
    let metadataPath = path.join(attachmentDirectory, IMAGE_METADATA_NAME);
    let metadata = await lstat(metadataPath).catch(() => undefined);
    if (!metadata && id === identity.attachmentId && identity.profileId === "local") {
      attachmentDirectory = path.join(this.#directory, identity.attachmentId);
      metadataPath = path.join(attachmentDirectory, IMAGE_METADATA_NAME);
      metadata = await lstat(metadataPath).catch(() => undefined);
    }
    const filePath = path.join(attachmentDirectory, "image.png");
    if (!metadata?.isFile() || metadata.size < 2 || metadata.size > IMAGE_METADATA_MAX_BYTES) {
      throw new Error("quickActionImageNotFound");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    } catch {
      throw new Error("quickActionImageChanged");
    }
    const storedMetadata = validStoredMetadata(parsed, identity.profileId, scopedId, identity.attachmentId)
      ? parsed
      : identity.profileId === "local" && id === identity.attachmentId && validHandle(parsed, id)
        ? legacyStoredMetadata(parsed, scopedId, identity.attachmentId)
        : undefined;
    if (!storedMetadata) throw new Error("quickActionImageChanged");
    const stored: StoredImage = {
      ...storedMetadata,
      filePath,
    };
    await verifyStoredImage(stored);
    this.#images.set(scopedId, stored);
    return { ...stored.handle };
  }

  async resolve(ids: readonly string[], expectedProfileId: string): Promise<QuickActionImageAttachment[]> {
    if (ids.length > 1 || new Set(ids).size !== ids.length) throw new Error("quickActionImageSelectionInvalid");
    await this.#prepareDirectory();
    await this.#removeExpiredFiles();
    const attachments: QuickActionImageAttachment[] = [];
    for (const id of ids) {
      const identity = imageIdentity(id);
      if (!identity || identity.profileId !== expectedProfileId) {
        throw new Error("quickActionImageSelectionInvalid");
      }
      const stored = this.#images.get(id);
      if (!stored || stored.profileId !== expectedProfileId) throw new Error("quickActionImageNotFound");
      await verifyStoredImage(stored);
      attachments.push({ ...stored.attachment });
    }
    return attachments;
  }

  async discard(id: string, expectedProfileId: string): Promise<void> {
    const identity = imageIdentity(id);
    if (!identity || identity.profileId !== expectedProfileId) return;
    const stored = this.#images.get(id);
    const scopedId = connectionAttachmentKey(identity.profileId, identity.attachmentId);
    this.#images.delete(id);
    this.#images.delete(scopedId);
    const attachmentDirectory = stored
      ? path.dirname(stored.filePath)
      : path.join(
          this.#directory,
          id === identity.attachmentId && identity.profileId === "local"
            ? identity.attachmentId
            : directoryName(identity.profileId, identity.attachmentId),
        );
    await unlink(path.join(attachmentDirectory, IMAGE_METADATA_NAME)).catch(() => undefined);
    await unlink(path.join(attachmentDirectory, "image.png")).catch(() => undefined);
    await rmdir(attachmentDirectory).catch(() => undefined);
  }

  async discardAfterLaunch(ids: readonly string[], expectedProfileId: string): Promise<void> {
    await Promise.all(ids.map((id) => this.discard(id, expectedProfileId)));
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
  }

  async #removeExpiredFiles(): Promise<void> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const cutoff = Date.now() - QUICK_ACTION_IMAGE_MAX_AGE_MS;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()
        || !(OWNED_ATTACHMENT_DIRECTORY.test(entry.name) || RAW_ATTACHMENT_ID.test(entry.name))) return;
      const attachmentDirectory = path.join(this.#directory, entry.name);
      const filePath = path.join(attachmentDirectory, "image.png");
      const metadataPath = path.join(attachmentDirectory, IMAGE_METADATA_NAME);
      const image = await lstat(filePath).catch(() => undefined);
      const draft = await lstat(metadataPath).catch(() => undefined);
      const createdAt = image?.isFile()
        ? image.mtimeMs
        : draft?.isFile()
          ? draft.mtimeMs
          : undefined;
      if (createdAt === undefined || createdAt >= cutoff) return;
      const separator = entry.name.indexOf("--");
      const profileId = separator < 0 ? "local" : entry.name.slice(0, separator);
      const attachmentId = separator < 0 ? entry.name : entry.name.slice(separator + 2);
      this.#images.delete(entry.name);
      this.#images.delete(connectionAttachmentKey(profileId, attachmentId));
      await unlink(metadataPath).catch(() => undefined);
      await unlink(filePath).catch(() => undefined);
      await rmdir(attachmentDirectory).catch(() => undefined);
    }));
  }
}

function validHandle(value: unknown, expectedId: string): value is QuickActionImageHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Partial<QuickActionImageHandle>;
  return handle.id === expectedId
    && handle.mediaType === "image/png"
    && Number.isInteger(handle.byteLength) && (handle.byteLength ?? 0) > 0 && (handle.byteLength ?? 0) <= QUICK_ACTION_IMAGE_MAX_BYTES
    && typeof handle.sha256 === "string" && SHA256.test(handle.sha256)
    && Number.isInteger(handle.width) && (handle.width ?? 0) > 0 && (handle.width ?? 0) <= QUICK_ACTION_IMAGE_MAX_DIMENSION
    && Number.isInteger(handle.height) && (handle.height ?? 0) > 0 && (handle.height ?? 0) <= QUICK_ACTION_IMAGE_MAX_DIMENSION
    && typeof handle.previewDataUrl === "string"
    && handle.previewDataUrl.startsWith("data:image/png;base64,")
    && handle.previewDataUrl.length <= IMAGE_METADATA_MAX_BYTES;
}

function validStoredMetadata(
  value: unknown,
  expectedProfileId: string,
  expectedHandleId: string,
  expectedAttachmentId: string,
): value is StoredImageMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<StoredImageMetadata>;
  const attachment = metadata.attachment;
  return metadata.profileId === expectedProfileId
    && validHandle(metadata.handle, expectedHandleId)
    && attachment?.attachmentId === expectedAttachmentId
    && attachment.mediaType === "image/png"
    && attachment.byteLength === metadata.handle.byteLength
    && attachment.sha256 === metadata.handle.sha256
    && attachment.width === metadata.handle.width
    && attachment.height === metadata.handle.height;
}

function imageIdentity(id: string): { profileId: string; attachmentId: string } | undefined {
  const identity = connectionAttachmentIdentity(id);
  if (!identity && RAW_ATTACHMENT_ID.test(id)) return { profileId: "local", attachmentId: id };
  if (!identity || !PROFILE_ID.test(identity.profileId) || !RAW_ATTACHMENT_ID.test(identity.entityId)) {
    return undefined;
  }
  return { profileId: identity.profileId, attachmentId: identity.entityId };
}

function legacyStoredMetadata(
  handle: QuickActionImageHandle,
  scopedId: string,
  attachmentId: string,
): StoredImageMetadata {
  const migratedHandle = { ...handle, id: scopedId };
  return {
    profileId: "local",
    handle: migratedHandle,
    attachment: {
      attachmentId,
      mediaType: "image/png",
      byteLength: handle.byteLength,
      sha256: handle.sha256,
      width: handle.width,
      height: handle.height,
    },
  };
}

function directoryName(profileId: string, attachmentId: string): string {
  if (!PROFILE_ID.test(profileId) || !RAW_ATTACHMENT_ID.test(attachmentId)) {
    throw new Error("quickActionImageSelectionInvalid");
  }
  return `${profileId}--${attachmentId}`;
}

async function verifyStoredImage(stored: StoredImage): Promise<void> {
  const metadata = await lstat(stored.filePath).catch(() => undefined);
  if (!metadata?.isFile()
    || metadata.size !== stored.handle.byteLength
    || metadata.mtimeMs < Date.now() - QUICK_ACTION_IMAGE_MAX_AGE_MS) {
    throw new Error("quickActionImageChanged");
  }
  const content = await readFile(stored.filePath);
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (digest !== stored.handle.sha256) throw new Error("quickActionImageChanged");
}
