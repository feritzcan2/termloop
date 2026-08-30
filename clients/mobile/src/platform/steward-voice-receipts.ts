import type { StewardVoiceReceipt, StewardVoiceReceiptStore } from "@/application/ports";

import type { SecretStore } from "./secure-connections";

const KEY_PREFIX = "termloop.mobile.steward-voice-receipt.v1.";

const emptyReceipt: StewardVoiceReceipt = {
  initialized: false,
  acknowledgedSequence: 0,
  pendingUserSequence: null,
};

/// A receipt is client-local delivery state, not a copy of the transcript. The
/// daemon remains the durable source of every message; the phone stores only
/// the last reply it finished speaking and an outstanding user turn sequence.
export function createStewardVoiceReceiptStore(
  store: Pick<SecretStore, "getItemAsync" | "setItemAsync">,
): StewardVoiceReceiptStore {
  return {
    async read(connectionId, projectId) {
      const value = await store.getItemAsync(keyOf(connectionId, projectId));
      if (value === null) return emptyReceipt;
      try {
        const parsed: unknown = JSON.parse(value);
        if (!validReceipt(parsed)) return emptyReceipt;
        return parsed;
      } catch {
        return emptyReceipt;
      }
    },
    async write(connectionId, projectId, receipt) {
      if (!validReceipt(receipt)) throw new Error("Steward voice receipt is invalid.");
      await store.setItemAsync(keyOf(connectionId, projectId), JSON.stringify(receipt));
    },
  };
}

function keyOf(connectionId: string, projectId: string): string {
  if (!validId(connectionId) || !validId(projectId)) {
    throw new Error("Steward voice receipt target is invalid.");
  }
  return `${KEY_PREFIX}${connectionId}.${projectId}`;
}

function validReceipt(value: unknown): value is StewardVoiceReceipt {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.initialized === "boolean"
    && Number.isSafeInteger(record.acknowledgedSequence)
    && Number(record.acknowledgedSequence) >= 0
    && (record.pendingUserSequence === null
      || (Number.isSafeInteger(record.pendingUserSequence) && Number(record.pendingUserSequence) >= 1));
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
