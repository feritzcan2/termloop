import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";

import type { ConnectionProfile } from "@/application/ports";
import { useMobileRuntime } from "@/composition/runtime-context";
import { connectionPresentation } from "@/presentation/connection-presentation";
import { useAppLifecycle } from "@/platform/app-lifecycle";

/// Longer than the generated control client's 12s request timeout, so a probe always
/// gets to finish before the next tick is even considered. A poll faster than the thing
/// it polls cannot converge — see the in-flight guard below.
const ACTIVE_PROBE_MS = 15_000;

/// Which saved Mac the app is currently reading, and the catalog it came from.
///
/// The selection is client-local navigation state and nothing more. It holds no
/// credential, decides no authentication policy, and is not durable truth — the
/// injected catalog port owns the records, and this store only remembers which one
/// the user is looking at.

export type CatalogLoad = "loading" | "ready" | "failed";

export interface ConnectionStore {
  load: CatalogLoad;
  error: string | undefined;
  connections: readonly ConnectionProfile[];
  selectedId: string | undefined;
  selected: ConnectionProfile | undefined;
  /// Other saved Macs, for the "Other Macs" group on Home.
  others: readonly ConnectionProfile[];
  select: (connectionId: string) => void;
  pair: (code: string) => Promise<void>;
  refresh: () => void;
}

const ConnectionContext = createContext<ConnectionStore | undefined>(undefined);

export function ConnectionProvider({ children }: PropsWithChildren) {
  const runtime = useMobileRuntime();
  const lifecycle = useAppLifecycle();
  const [load, setLoad] = useState<CatalogLoad>("loading");
  const [error, setError] = useState<string | undefined>(undefined);
  const [connections, setConnections] = useState<readonly ConnectionProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [reloads, setReloads] = useState(0);
  /// Whether a probe is currently in flight. A tick that lands mid-probe must be dropped
  /// rather than restarting the effect: the restart's cleanup marks the running attempt
  /// stale, so its result is discarded when it finally arrives.
  const probing = useRef(false);

  useEffect(() => {
    if (!lifecycle.active) return;
    let active = true;
    probing.current = true;
    setLoad((current) => (current === "ready" ? current : "loading"));
    setError(undefined);
    runtime.connections.list().then(
      (profiles) => {
        probing.current = false;
        if (!active) return;
        setConnections(profiles);
        setLoad("ready");
        /// One resume of the last-used Mac per cold start. Any explicit tap wins,
        /// which is why this only fills an empty selection and never replaces one.
        setSelectedId((current) => (
          current !== undefined && profiles.some((profile) => profile.id === current)
            ? current
            : preferredConnectionId(profiles)
        ));
      },
      (cause: unknown) => {
        probing.current = false;
        if (!active) return;
        setError(describe(cause));
        setLoad("failed");
      },
    );
    return () => { active = false; };
  }, [runtime, reloads, lifecycle.active, lifecycle.foregroundRevision]);

  // The phone never asks the user to tap Retry just because the Mac, Tailscale,
  // Wi-Fi, or daemon was briefly unavailable. While visible it keeps probing the
  // saved credential; foregrounding triggers an immediate probe above.
  useEffect(() => {
    if (!lifecycle.active) return;
    const timer = setInterval(() => {
      /// An unreachable Mac takes the full control-request timeout to fail. Bumping the
      /// reload counter while that is still running cancels the attempt that was about
      /// to answer, so every probe is replaced a moment before it settles and the
      /// catalog never leaves `loading` — a permanent spinner produced by the retry
      /// loop itself rather than by the network.
      if (probing.current) return;
      setReloads((count) => count + 1);
    }, ACTIVE_PROBE_MS);
    return () => clearInterval(timer);
  }, [lifecycle.active]);

  const select = useCallback((connectionId: string) => setSelectedId(connectionId), []);
  const refresh = useCallback(() => setReloads((count) => count + 1), []);
  const pair = useCallback(async (code: string) => {
    const connectionId = await runtime.connections.pair(code);
    setSelectedId(connectionId);
    setReloads((count) => count + 1);
  }, [runtime]);

  const value = useMemo<ConnectionStore>(() => {
    const selected = connections.find((profile) => profile.id === selectedId);
    return {
      load,
      error,
      connections,
      selectedId,
      selected,
      others: connections.filter((profile) => profile.id !== selectedId),
      select,
      pair,
      refresh,
    };
  }, [load, error, connections, selectedId, select, pair, refresh]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnections(): ConnectionStore {
  const store = useContext(ConnectionContext);
  if (!store) throw new Error("Connection provider is missing");
  return store;
}

/// The Mac the app opens on: the most recently connected one that can actually be
/// read. An unreachable or update-blocked Mac is never auto-selected, because
/// landing the user on a dead screen is worse than landing them on the list.
function preferredConnectionId(profiles: readonly ConnectionProfile[]): string | undefined {
  const usable = profiles
    .filter((profile) => connectionPresentation(profile.availability).block === undefined)
    .sort((left, right) => (right.lastConnectedAtEpochMs ?? 0) - (left.lastConnectedAtEpochMs ?? 0));
  return usable[0]?.id;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The saved Macs could not be read.";
}
