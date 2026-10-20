import { connectionAttachmentIdentity } from "../../connection-scope.js";
import type { QuickActionImageHandle } from "../../quick-action-image.js";

type QuickActionImageRestorePorts = {
  selectedProfileId(): string;
  restore(attachmentId: string): Promise<QuickActionImageHandle>;
};

/// Quick Action restores its saved draft image from an effect that handles only
/// a rejected promise. Every refusal must therefore reject: a synchronous throw
/// escapes that effect and unmounts the whole window.
export function createQuickActionImageRestore(ports: QuickActionImageRestorePorts) {
  return async (attachmentId: string): Promise<QuickActionImageHandle> => {
    const profileId = connectionAttachmentIdentity(attachmentId)?.profileId ?? "local";
    if (profileId !== ports.selectedProfileId()) {
      throw new Error("The saved image belongs to another computer. Paste it again for this Project.");
    }
    return ports.restore(attachmentId);
  };
}
