import { requireOptionalNativeModule } from "expo";

export interface WatchSyncBridge {
  /// Delivers an atomic multi-Mac credential catalog to the paired watch. The
  /// bridge merges refreshed entries with its last application context so a
  /// temporarily offline, still-saved Mac remains available on the Watch.
  syncCredentials(
    credentials: readonly WatchCredentialTransfer[],
    activeConnectionIds: readonly string[],
  ): Promise<boolean>;
}

export interface WatchCredentialTransfer {
  connectionId: string;
  name: string;
  host: string;
  token: string;
  targetProjectId: string | null;
}

interface NativeWatchSync {
  syncCredentials(
    credentials: readonly WatchCredentialTransfer[],
    activeConnectionIds: readonly string[],
  ): Promise<boolean>;
}

const native = requireOptionalNativeModule<NativeWatchSync>("WatchSync");

export const watchSyncBridge: WatchSyncBridge = {
  async syncCredentials(credentials, activeConnectionIds) {
    if (native === null) return false;
    return native.syncCredentials(credentials, activeConnectionIds);
  },
};
