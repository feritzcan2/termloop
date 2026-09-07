import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentLibraryResult } from "@termloop/contract/current";
import type { AgentLibraryController } from "../agent-library.js";
import type { SourceDesktopApi } from "../transport/desktop-api.js";

export function useAgentLibrary(api: SourceDesktopApi, connected: boolean): AgentLibraryController {
  const [snapshot, setSnapshot] = useState<{ api: SourceDesktopApi; value: AgentLibraryResult }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const activeApi = useRef(api);
  activeApi.current = api;
  const accept = useCallback((value: AgentLibraryResult) => {
    if (activeApi.current !== api) throw new Error("The connection changed. Reopen the agent library on the current connection.");
    setSnapshot((previous) => previous?.api === api && previous.value.revision > value.revision ? previous : { api, value });
  }, [api]);
  const reload = useCallback(() => {
    if (!connected) return;
    const request = ++generation.current;
    setLoading(true);
    setError(undefined);
    void api.agentLibraryGet().then((value) => {
      if (request === generation.current) accept(value);
    }).catch((cause) => {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (request === generation.current) setLoading(false);
    });
  }, [api, connected, accept]);
  useEffect(() => {
    setSnapshot(undefined);
    setError(undefined);
    setLoading(false);
    reload();
    window.addEventListener("focus", reload);
    return () => { generation.current++; window.removeEventListener("focus", reload); };
  }, [reload]);
  return {
    value: connected && snapshot?.api === api ? snapshot.value : undefined,
    loading, error, reload,
    async create(draft, expectedRevision) {
      const value = await api.agentProfileCreate({ ...draft, expectedRevision });
      accept(value);
      const created = value.profiles[value.profiles.length - 1];
      if (!created || created.source !== "personal") throw new Error("Agent creation returned no personal agent.");
      return created;
    },
    async update(params) { accept(await api.agentProfileUpdate(params)); },
    async remove(id, expectedRevision) { accept(await api.agentProfileDelete({ id, expectedRevision })); },
    async favorite(id, favorite, expectedRevision) { accept(await api.agentProfileFavorite({ id, favorite, expectedRevision })); },
  };
}
