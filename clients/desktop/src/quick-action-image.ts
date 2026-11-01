/** Mirrors the generated contract's Quick Action `attachments.maxItems`. */
export const QUICK_ACTION_IMAGE_LIMIT = 8;

export type QuickActionImageHandle = {
  id: string;
  mediaType: "image/png";
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  previewDataUrl: string;
};
