import { createHash } from "node:crypto";
import type { QuickActionImageAttachment } from "@termloop/contract/current";

import { connectionConfig, controlCall } from "./control.js";

export async function uploadQuickActionImage(
  png: Uint8Array,
  width: number,
  height: number,
): Promise<QuickActionImageAttachment> {
  const sha256 = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  const upload = await controlCall("attachment.beginUpload", {
    mediaType: "image/png",
    byteLength: png.byteLength,
    sha256,
    width,
    height,
  });
  const config = await connectionConfig();
  if (!config) throw new Error("daemonUnavailable");
  const uploadUrl = attachmentUploadUrl(config.controlUrl);
  const response = await fetch(uploadUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(35_000),
    headers: {
      authorization: `Bearer ${upload.uploadTicket}`,
      "content-type": "image/png",
    },
    body: Buffer.from(png),
  });
  if (!response.ok) throw new Error(`quickActionImageUploadFailed:${response.status}`);
  const attachment = await response.json() as QuickActionImageAttachment;
  if (attachment.mediaType !== "image/png"
    || attachment.byteLength !== png.byteLength
    || attachment.sha256 !== sha256
    || attachment.width !== width
    || attachment.height !== height) {
    throw new Error("quickActionImageUploadInvalid");
  }
  return attachment;
}

export function attachmentUploadUrl(controlUrl: string): string {
  const url = new URL(controlUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else throw new Error("control transport does not support attachment uploads");
  url.pathname = "/attachments";
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString();
}
