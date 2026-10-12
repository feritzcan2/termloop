import type { CachedDiff } from "./change-source.js";

export async function changesReviewFingerprint(diff: CachedDiff): Promise<string | null> {
  // A refusal/binary marker does not identify content. These can only be marked
  // for the current observation, never restored as verified file reviews.
  if (diff.state !== "patch" || diff.patch === null) return null;
  const bytes = new TextEncoder().encode(diff.patch);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** No timers, retries, or background ownership. Closing/changing the editor
 * stops queued reads and discards results of already dispatched named reads. */
export async function visitReviewEntries(
  entryIds: readonly string[],
  visit: (entryId: string) => Promise<void>,
  isActive: () => boolean,
): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (isActive() && index < entryIds.length) {
      const entryId = entryIds[index++]!;
      await visit(entryId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, entryIds.length) }, worker));
}
