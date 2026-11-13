import { requireOptionalNativeModule } from "expo";

/// One image the share extension staged in the App Group inbox. The URI stays
/// on the phone; the image adapter streams its bytes to the Mac like any other
/// composer image.
export interface SharedImage {
  uri: string;
  mediaType: string | null;
  width: number;
  height: number;
}

export interface ShareInbox {
  read(batchId: string): SharedImage | undefined;
  remove(batchId: string): void;
}

export interface NativeShareInbox {
  read(batchId: string): { uri: unknown; mediaType: unknown; width: unknown; height: unknown } | null;
  remove(batchId: string): void;
}

const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/// The batch arrives in a URL anyone can open, so it is only ever an identifier:
/// anything that is not a lowercase UUID is ignored before it reaches native code.
export function validShareBatchId(value: unknown): value is string {
  return typeof value === "string" && BATCH_ID.test(value);
}

export function createShareInbox(native: NativeShareInbox | null): ShareInbox {
  return {
    read(batchId) {
      if (native === null || !validShareBatchId(batchId)) return undefined;
      const entry = native.read(batchId);
      if (entry === null || typeof entry.uri !== "string" || !entry.uri.startsWith("file://")) return undefined;
      return {
        uri: entry.uri,
        mediaType: typeof entry.mediaType === "string" ? entry.mediaType : null,
        width: typeof entry.width === "number" ? entry.width : 0,
        height: typeof entry.height === "number" ? entry.height : 0,
      };
    },
    remove(batchId) {
      if (native === null || !validShareBatchId(batchId)) return;
      native.remove(batchId);
    },
  };
}

export const shareInbox = createShareInbox(requireOptionalNativeModule<NativeShareInbox>("ShareInbox"));
