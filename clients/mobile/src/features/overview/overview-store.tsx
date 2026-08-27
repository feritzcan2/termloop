import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";

import type { MobileOverview } from "@/application/ports";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { connectionPresentation } from "@/presentation/connection-presentation";
import { reconcileReviewReadySessions, statusMap } from "@/presentation/agent-review-policy";
import { useAppLifecycle } from "@/platform/app-lifecycle";

/// Longer than the control client's request timeout, and this read fans out to several
/// calls, so it is slower than a bare version probe. Refreshing faster than the read can
/// finish replaces each attempt just before it answers.
const ACTIVE_REFRESH_MS = 15_000;

/// Every readable Mac's Project/Task/Session/Agent-status projection, loaded once and
/// shared by every screen that reads it. The selected connection remains a facade for
/// Project-scoped routes; Home reads the complete connection-indexed map.
///
/// One read per connection rather than one per screen: Task detail, the overview, and
/// the Project selector are three depths of the same projection, and refetching per
/// screen is how two surfaces start disagreeing about the same Task.

export type OverviewLoad = "idle" | "loading" | "ready" | "failed";

export interface ConnectionOverviewSnapshot {
  load: OverviewLoad;
  error: string | undefined;
  overview: MobileOverview | undefined;
  refreshing: boolean;
  reviewReadySessionIds: ReadonlySet<string>;
  readAtEpochMs: number | undefined;
}

export interface OverviewStore extends ConnectionOverviewSnapshot {
  /// Every readable Mac is loaded concurrently. Navigation still selects one
  /// connection for mutations and terminal attachment, while Home can project one
  /// location-labelled Project list without inventing cross-Mac domain state.
  byConnection: ReadonlyMap<string, ConnectionOverviewSnapshot>;
  refresh: () => void;
  dismissReview: (sessionId: string) => void;
}

const OverviewContext = createContext<OverviewStore | undefined>(undefined);

export function OverviewProvider({ children }: PropsWithChildren) {
  const runtime = useMobileRuntime();
  const lifecycle = useAppLifecycle();
  const { connections, selected } = useConnections();
  const [byConnection, setByConnection] = useState<ReadonlyMap<string, ConnectionOverviewSnapshot>>(new Map());
  const [reloads, setReloads] = useState(0);
  const previousStatuses = useRef<ReadonlyMap<string, ReadonlyMap<string, string>>>(new Map());
  /// See `connection-store`: a tick that lands mid-read must be dropped, not allowed to
  /// restart the effect and discard the answer that was already on its way.
  const reading = useRef(false);

  const readableConnections = connections.filter(
    (connection) => connectionPresentation(connection.availability).block === undefined,
  );
  const connectionScope = connections
    .map((connection) => `${connection.id}:${connection.availability}`)
    .join("\u0000");

  useEffect(() => {
    if (!lifecycle.active) return;
    const readableIds = new Set(readableConnections.map(({ id }) => id));
    setByConnection((current) => {
      const next = new Map<string, ConnectionOverviewSnapshot>();
      for (const connection of connections) {
        const previous = current.get(connection.id);
        if (!readableIds.has(connection.id)) {
          next.set(connection.id, emptySnapshot());
        } else {
          next.set(connection.id, {
            ...(previous ?? emptySnapshot()),
            load: previous?.overview === undefined ? "loading" : "ready",
            error: undefined,
            refreshing: true,
          });
        }
      }
      return next;
    });
    previousStatuses.current = new Map(
      [...previousStatuses.current].filter(([connectionId]) => readableIds.has(connectionId)),
    );
    if (readableConnections.length === 0) {
      reading.current = false;
      return;
    }
    let active = true;
    reading.current = true;
    void Promise.all(readableConnections.map(async ({ id: connectionId }) => {
      try {
        const nextOverview = await runtime.control.loadOverview(connectionId);
        if (!active) return;
        setByConnection((current) => {
          const previous = current.get(connectionId) ?? emptySnapshot();
          const previousStatus = previousStatuses.current.get(connectionId) ?? new Map<string, string>();
          const nextReviewReady = reconcileReviewReadySessions(
            previous.reviewReadySessionIds,
            previousStatus,
            nextOverview.agentStatuses,
          );
          previousStatuses.current = new Map(previousStatuses.current).set(
            connectionId,
            statusMap(nextOverview.agentStatuses),
          );
          return new Map(current).set(connectionId, {
            load: "ready",
            error: undefined,
            overview: nextOverview,
            refreshing: false,
            reviewReadySessionIds: nextReviewReady,
            readAtEpochMs: Date.now(),
          });
        });
      } catch (cause: unknown) {
        if (!active) return;
        setByConnection((current) => {
          const previous = current.get(connectionId) ?? emptySnapshot();
          return new Map(current).set(connectionId, {
            ...previous,
            load: "failed",
            error: cause instanceof Error ? cause.message : "This Mac's projects could not be read.",
            refreshing: false,
          });
        });
      }
    })).finally(() => {
      if (active) reading.current = false;
    });
    return () => { active = false; };
  }, [runtime, connectionScope, reloads, lifecycle.active, lifecycle.foregroundRevision]);

  useEffect(() => {
    if (!lifecycle.active || readableConnections.length === 0) return;
    const timer = setInterval(() => {
      if (reading.current) return;
      setReloads((count) => count + 1);
    }, ACTIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [lifecycle.active, connectionScope]);

  const refresh = useCallback(() => setReloads((count) => count + 1), []);
  const dismissReview = useCallback((sessionId: string) => {
    if (selected === undefined) return;
    setByConnection((current) => {
      const snapshot = current.get(selected.id);
      if (snapshot === undefined || !snapshot.reviewReadySessionIds.has(sessionId)) return current;
      const nextReviewReady = new Set(snapshot.reviewReadySessionIds);
      nextReviewReady.delete(sessionId);
      return new Map(current).set(selected.id, {
        ...snapshot,
        reviewReadySessionIds: nextReviewReady,
      });
    });
  }, [selected]);

  const selectedSnapshot = selected === undefined
    ? emptySnapshot()
    : byConnection.get(selected.id) ?? emptySnapshot();
  const value = useMemo<OverviewStore>(
    () => ({
      ...selectedSnapshot,
      byConnection,
      refresh,
      dismissReview,
    }),
    [selectedSnapshot, byConnection, refresh, dismissReview],
  );

  return <OverviewContext.Provider value={value}>{children}</OverviewContext.Provider>;
}

function emptySnapshot(): ConnectionOverviewSnapshot {
  return {
    load: "idle",
    error: undefined,
    overview: undefined,
    refreshing: false,
    reviewReadySessionIds: new Set(),
    readAtEpochMs: undefined,
  };
}

export function useOverview(): OverviewStore {
  const store = useContext(OverviewContext);
  if (!store) throw new Error("Overview provider is missing");
  return store;
}
