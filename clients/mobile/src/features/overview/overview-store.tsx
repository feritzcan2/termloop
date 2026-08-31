import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";

import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { connectionPresentation } from "@/presentation/connection-presentation";
import { reconcileReviewReadySessions, statusMap } from "@/presentation/agent-review-policy";
import { useAppLifecycle } from "@/platform/app-lifecycle";
import {
  emptyOverviewSnapshot as emptySnapshot,
  snapshotWhileUnavailable,
  type ConnectionOverviewSnapshot,
  type OverviewLoad,
} from "./overview-resilience";

export {
  snapshotWhileUnavailable,
  type ConnectionOverviewSnapshot,
  type OverviewLoad,
} from "./overview-resilience";

/// Longer than the control client's request timeout, and this read fans out to several
/// calls, so it is slower than a bare version probe. Refreshing faster than the read can
/// finish replaces each attempt just before it answers.
const FALLBACK_REFRESH_MS = 120_000;
const INVALIDATION_DEBOUNCE_MS = 120;

/// Every readable Mac's Project/Task/Session/Agent-status projection, loaded once and
/// shared by every screen that reads it. The selected connection remains a facade for
/// Project-scoped routes; Home reads the complete connection-indexed map.
///
/// One read per connection rather than one per screen: Task detail, the overview, and
/// the Project selector are three depths of the same projection, and refetching per
/// screen is how two surfaces start disagreeing about the same Task.

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
  const readSequence = useRef(0);
  const activeRead = useRef<number | undefined>(undefined);
  const pendingInvalidation = useRef(false);
  const invalidationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastInvalidations = useRef(new Map<string, string>());

  const readableConnections = connections.filter(
    (connection) => connectionPresentation(connection.availability).block === undefined,
  );
  const connectionScope = connections
    .map((connection) => `${connection.id}:${connection.availability}`)
    .join("\u0000");

  useEffect(() => {
    if (!lifecycle.active) return;
    const readableIds = new Set(readableConnections.map(({ id }) => id));
    const knownIds = new Set(connections.map(({ id }) => id));
    setByConnection((current) => {
      const next = new Map<string, ConnectionOverviewSnapshot>();
      for (const connection of connections) {
        const previous = current.get(connection.id);
        if (!readableIds.has(connection.id)) {
          /// A transient offline verdict must not make the Mac, its Projects, or
          /// its Agents disappear from Home. Retain only an already-observed
          /// projection and let the connection warning mark it as stale. Revoked
          /// and incompatible Macs still lose the projection immediately.
          next.set(connection.id, snapshotWhileUnavailable(connection.availability, previous));
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
      [...previousStatuses.current].filter(([connectionId]) => knownIds.has(connectionId)),
    );
    for (const connectionId of lastInvalidations.current.keys()) {
      if (!knownIds.has(connectionId)) lastInvalidations.current.delete(connectionId);
    }
    const read = ++readSequence.current;
    if (readableConnections.length === 0) {
      activeRead.current = undefined;
      return;
    }
    let active = true;
    activeRead.current = read;
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
      if (active && activeRead.current === read) {
        activeRead.current = undefined;
        if (pendingInvalidation.current) {
          pendingInvalidation.current = false;
          setReloads((count) => count + 1);
        }
      }
    });
    return () => { active = false; };
  }, [runtime, connectionScope, reloads, lifecycle.active, lifecycle.foregroundRevision]);

  useEffect(() => {
    if (!lifecycle.active || readableConnections.length === 0) return;
    const subscriptions = readableConnections.map(({ id: connectionId }) => (
      runtime.control.subscribeInvalidations(connectionId, (event) => {
        const revision = `${event.stateRevision}:${event.observationSequence}`;
        if (lastInvalidations.current.get(connectionId) === revision) return;
        // A daemon restart may reset either counter. Invalidations are hints and
        // reads remain authoritative, so reject only exact redelivery rather
        // than suppressing a valid lower sequence for the rest of this app run.
        lastInvalidations.current.set(connectionId, revision);
        if (invalidationTimer.current !== undefined) clearTimeout(invalidationTimer.current);
        invalidationTimer.current = setTimeout(() => {
          invalidationTimer.current = undefined;
          if (activeRead.current !== undefined) {
            pendingInvalidation.current = true;
            return;
          }
          setReloads((count) => count + 1);
        }, INVALIDATION_DEBOUNCE_MS);
      })
    ));
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      if (invalidationTimer.current !== undefined) clearTimeout(invalidationTimer.current);
      invalidationTimer.current = undefined;
    };
  }, [runtime, lifecycle.active, connectionScope]);

  useEffect(() => {
    if (!lifecycle.active || readableConnections.length === 0) return;
    const timer = setInterval(() => {
      if (activeRead.current !== undefined) return;
      setReloads((count) => count + 1);
    }, FALLBACK_REFRESH_MS);
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

export function useOverview(): OverviewStore {
  const store = useContext(OverviewContext);
  if (!store) throw new Error("Overview provider is missing");
  return store;
}
