import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";

import type { ConnectionProfile } from "@/application/ports";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useAppLifecycle } from "@/platform/app-lifecycle";
import { preferredConnectionId, shouldResetConnectionTransports } from "./connection-resilience";

export { preferredConnectionId } from "./connection-resilience";

/// Longer than the generated control client's 12s request timeout, so a probe always
/// gets to finish before the next tick is even considered. A poll faster than the thing
/// it polls cannot converge — see the in-flight guard below.
const FALLBACK_PROBE_MS = 60_000;
const RECONNECT_PROBE_MS = 3_000;
export const CONNECTION_RECONNECT_GRACE_MS = 12_000;

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
  const connectionsRef = useRef<readonly ConnectionProfile[]>([]);
  /// Whether a probe is currently in flight. A tick that lands mid-probe must be dropped
  /// rather than restarting the effect: the restart's cleanup marks the running attempt
  /// stale, so its result is discarded when it finally arrives.
  const probeSequence = useRef(0);
  const activeProbe = useRef<number | undefined>(undefined);
  const unreachableSince = useRef(new Map<string, number>());
  const pendingTransportChange = useRef(false);
  const transportLifecycle = useRef(lifecycle);

  useEffect(() => {
    /// iOS can retain a WebSocket object across suspension after its network path
    /// has disappeared. Close cached transports before suspension when that state
    /// commits, and again after every real foreground so batched lifecycle events
    /// cannot leave catalog, overview, and terminal reads on a zombie path.
    const previous = transportLifecycle.current;
    transportLifecycle.current = lifecycle;
    if (shouldResetConnectionTransports(previous, lifecycle)) {
      runtime.connections.resetTransports();
    }
  }, [runtime, lifecycle.active, lifecycle.foregroundRevision]);

  useEffect(() => {
    if (!lifecycle.active) return;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const probe = ++probeSequence.current;
    activeProbe.current = probe;
    setLoad((current) => (current === "ready" ? current : "loading"));
    setError(undefined);
    const scheduleRetry = () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (active && activeProbe.current === undefined) setReloads((count) => count + 1);
      }, RECONNECT_PROBE_MS);
    };
    runtime.connections.list().then(
      (profiles) => {
        if (activeProbe.current === probe) activeProbe.current = undefined;
        if (!active) return;
        const now = Date.now();
        let reconnecting = false;
        const knownIds = new Set(profiles.map((profile) => profile.id));
        for (const connectionId of unreachableSince.current.keys()) {
          if (!knownIds.has(connectionId)) unreachableSince.current.delete(connectionId);
        }
        const nextConnections: ConnectionProfile[] = profiles.map((profile) => {
          if (profile.availability !== "offline" && profile.availability !== "reconnecting") {
            unreachableSince.current.delete(profile.id);
            return profile;
          }
          const startedAt = unreachableSince.current.get(profile.id) ?? now;
          unreachableSince.current.set(profile.id, startedAt);
          if (profile.availability === "offline" && now - startedAt >= CONNECTION_RECONNECT_GRACE_MS) {
            return profile;
          }
          reconnecting = true;
          const previous = connectionsRef.current.find((candidate) => candidate.id === profile.id);
          return {
            ...profile,
            availability: "reconnecting",
            productVersion: profile.productVersion ?? previous?.productVersion ?? null,
            contractIdentity: profile.contractIdentity ?? previous?.contractIdentity ?? null,
          };
        });
        connectionsRef.current = nextConnections;
        setConnections(nextConnections);
        setLoad("ready");
        /// One resume of the last-used Mac per cold start. Any explicit tap wins,
        /// which is why this only fills an empty selection and never replaces one.
        setSelectedId((current) => (
          current !== undefined && profiles.some((profile) => profile.id === current)
            ? current
            : preferredConnectionId(profiles)
        ));
        if (reconnecting) scheduleRetry();
        if (pendingTransportChange.current) {
          pendingTransportChange.current = false;
          queueMicrotask(() => {
            if (active) setReloads((count) => count + 1);
          });
        }
      },
      (cause: unknown) => {
        if (activeProbe.current === probe) activeProbe.current = undefined;
        if (!active) return;
        setError(describe(cause));
        setLoad("failed");
        scheduleRetry();
      },
    );
    return () => {
      active = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [runtime, reloads, lifecycle.active, lifecycle.foregroundRevision]);

  useEffect(() => {
    if (!lifecycle.active) return;
    return runtime.connections.subscribeChanges(() => {
      if (activeProbe.current !== undefined) {
        pendingTransportChange.current = true;
        return;
      }
      setReloads((count) => count + 1);
    });
  }, [runtime, lifecycle.active]);

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
      if (activeProbe.current !== undefined) return;
      setReloads((count) => count + 1);
    }, FALLBACK_PROBE_MS);
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

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The saved Macs could not be read.";
}
