import type { SecretStore } from "./secure-connections";

const KEY_PREFIX = "termloop.mobile.watch-target.v1.";

/// Client-local selection for the paired Watch's default Steward destination.
/// It is deliberately separate from the connection credential record: changing
/// a Watch preference must never rewrite or expose a connection secret.
export interface WatchTargetSettings {
  get(connectionId: string): Promise<string | null>;
  set(connectionId: string, projectId: string): Promise<void>;
}

export function createWatchTargetSettings(store: Pick<SecretStore, "getItemAsync" | "setItemAsync">): WatchTargetSettings {
  return {
    async get(connectionId) {
      const value = await store.getItemAsync(keyOf(connectionId));
      return validProjectId(value) ? value : null;
    },
    async set(connectionId, projectId) {
      if (!validProjectId(projectId)) throw new Error("Watch target Project is invalid.");
      await store.setItemAsync(keyOf(connectionId), projectId);
    },
  };
}

function keyOf(connectionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(connectionId)) {
    throw new Error("Watch target connection is invalid.");
  }
  return `${KEY_PREFIX}${connectionId}`;
}

function validProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value);
}
