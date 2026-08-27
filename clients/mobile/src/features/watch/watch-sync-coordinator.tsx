import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";

/// Provisions the paired Apple Watch with the complete saved-Mac catalog. The
/// runtime refreshes watch credentials for reachable Macs while the native
/// bridge retains still-saved offline entries from its previous context.
export function WatchSyncCoordinator() {
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const syncedSignature = useRef<string | undefined>(undefined);
  const signature = connections.connections
    .map((connection) => `${connection.id}:${connection.name}:${connection.availability}`)
    .sort()
    .join("|");

  useEffect(() => {
    if (Platform.OS !== "ios" || runtime.kind !== "production") return;
    if (connections.load !== "ready" || syncedSignature.current === signature) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const sync = async () => {
      try {
        const delivered = await runtime.watch.sync();
        if (delivered) syncedSignature.current = signature;
        else if (active) retry = setTimeout(sync, 30_000);
      } catch {
        if (active) retry = setTimeout(sync, 30_000);
      }
    };
    void sync();
    return () => {
      active = false;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [runtime, connections.load, signature]);

  return null;
}
