import { useCallback, useEffect, useRef, useState } from "react";

import type { ConnectionProfileSummary } from "../../connection-profile-types.js";
import { desktopApi } from "../transport/desktop-api.js";
import { onConnectionStatus } from "../transport/connection-events.js";

/** Connection scope stays visible even when a remote computer has no Projects. */
export function useSettingsComputers() {
  const [profiles, setProfiles] = useState<ConnectionProfileSummary[]>([]);
  const generation = useRef(0);
  const list = useCallback(async () => {
    const request = ++generation.current;
    const next = await desktopApi.connectionProfileList();
    if (request === generation.current) setProfiles(next);
    return next;
  }, []);
  useEffect(() => {
    const refresh = () => { void list().catch(() => undefined); };
    refresh();
    const unsubscribe = onConnectionStatus(refresh);
    return () => { generation.current++; unsubscribe(); };
  }, [list]);
  return { profiles, list };
}
