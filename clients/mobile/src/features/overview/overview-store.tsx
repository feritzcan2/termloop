import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";

import type { ConnectionAvailability } from "@/application/ports";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { connectionPresentation } from "@/presentation/connection-presentation";
import { reconcileReviewReadySessions, statusMap } from "@/presentation/agent-review-policy";
import { useAppLifecycle } from "@/platform/app-lifecycle";
import {
  emptyOverviewSnapshot as emptySnapshot,
  snapshotWhileBackgrounded,
  snapshotWhileUnavailable,
  type ConnectionOverviewSnapshot,
  type OverviewLoad,
} from "./overview-resilience";

export {
  snapshotWhileBackgrounded,
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
  const { connections, selected } = useConnections();
  const [byConnection, setByConnection] = useState<ReadonlyMap<string, ConnectionOverviewSnapshot>>(new Map());
  const [reloads, setReloads] = useState(0);
  const connectionIds = connections.map(({ id }) => id).join("\u0000");

  /// Each loader owns exactly one Mac's read generation and invalidation queue.
  /// A dead Mac can therefore change availability or exhaust its timeout without
  /// cancelling the healthy Mac answer already travelling to the phone.
  const updateSnapshot = useCallback((
    connectionId: string,
    update: (current: ConnectionOverviewSnapshot | undefined) => ConnectionOverviewSnapshot,
  ) => {
    setByConnection((current) => new Map(current).set(connectionId, update(current.get(connectionId))));
  }, []);

  useEffect(() => {
    const knownIds = new Set(connections.map(({ id }) => id));
    setByConnection((current) => {
      if ([...current.keys()].every((connectionId) => knownIds.has(connectionId))) return current;
      return new Map([...current].filter(([connectionId]) => knownIds.has(connectionId)));
    });
  }, [connectionIds]);

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

  return (
    <OverviewContext.Provider value={value}>
      {connections.map((connection) => (
        <ConnectionOverviewLoader
          key={connection.id}
          connectionId={connection.id}
          availability={connection.availability}
          refreshRevision={reloads}
          updateSnapshot={updateSnapshot}
        />
      ))}
      {children}
    </OverviewContext.Provider>
  );
}

interface ConnectionOverviewLoaderProps {
  connectionId: string;
  availability: ConnectionAvailability;
  refreshRevision: number;
  updateSnapshot: (
    connectionId: string,
    update: (current: ConnectionOverviewSnapshot | undefined) => ConnectionOverviewSnapshot,
  ) => void;
}

/// A route-independent projection reader for one paired Mac. Keeping this as a
/// keyed child gives React a separate effect lifetime per connection: changes to
/// Mac A re-render Mac B but cannot clean up or invalidate Mac B's in-flight read.
function ConnectionOverviewLoader({
  connectionId,
  availability,
  refreshRevision,
  updateSnapshot,
}: ConnectionOverviewLoaderProps) {
  const runtime = useMobileRuntime();
  const lifecycle = useAppLifecycle();
  const [localReloads, setLocalReloads] = useState(0);
  const previousStatuses = useRef<ReadonlyMap<string, string>>(new Map());
  const readSequence = useRef(0);
  const activeRead = useRef<number | undefined>(undefined);
  const pendingInvalidation = useRef(false);
  const invalidationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastInvalidation = useRef<string | undefined>(undefined);
  const readable = connectionPresentation(availability).block === undefined;

  useEffect(() => {
    if (!lifecycle.active) {
      activeRead.current = undefined;
      updateSnapshot(connectionId, snapshotWhileBackgrounded);
      return;
    }
    if (!readable) {
      activeRead.current = undefined;
      if (availability !== "offline") previousStatuses.current = new Map();
      updateSnapshot(connectionId, (previous) => {
        /// A transient offline verdict must not make the Mac, its Projects, or
        /// its Agents disappear from Home. Revoked and incompatible Macs still
        /// lose their projections immediately.
        return snapshotWhileUnavailable(availability, previous);
      });
      return;
    }

    updateSnapshot(connectionId, (previous) => ({
      ...(previous ?? emptySnapshot()),
      load: previous?.overview === undefined ? "loading" : "ready",
      error: undefined,
      refreshing: true,
    }));
    const read = ++readSequence.current;
    activeRead.current = read;
    let active = true;
    void runtime.control.loadOverview(connectionId).then(
      (nextOverview) => {
        if (!active || activeRead.current !== read) return;
        updateSnapshot(connectionId, (current) => {
          const previous = current ?? emptySnapshot();
          const nextReviewReady = reconcileReviewReadySessions(
            previous.reviewReadySessionIds,
            previousStatuses.current,
            nextOverview.agentStatuses,
          );
          previousStatuses.current = statusMap(nextOverview.agentStatuses);
          return {
            load: "ready",
            error: undefined,
            overview: nextOverview,
            refreshing: false,
            reviewReadySessionIds: nextReviewReady,
            readAtEpochMs: Date.now(),
          };
        });
      },
      (cause: unknown) => {
        if (!active || activeRead.current !== read) return;
        updateSnapshot(connectionId, (current) => ({
          ...(current ?? emptySnapshot()),
          load: "failed",
          error: cause instanceof Error ? cause.message : "This Mac's projects could not be read.",
          refreshing: false,
        }));
      },
    ).finally(() => {
      if (!active || activeRead.current !== read) return;
      activeRead.current = undefined;
      if (pendingInvalidation.current) {
        pendingInvalidation.current = false;
        setLocalReloads((count) => count + 1);
      }
    });
    return () => {
      active = false;
      if (activeRead.current === read) activeRead.current = undefined;
    };
  }, [
    runtime,
    connectionId,
    availability,
    readable,
    refreshRevision,
    localReloads,
    lifecycle.active,
    lifecycle.foregroundRevision,
    updateSnapshot,
  ]);

  useEffect(() => {
    if (!lifecycle.active || !readable) return;
    const unsubscribe = runtime.control.subscribeInvalidations(connectionId, (event) => {
      const revision = `${event.stateRevision}:${event.observationSequence}`;
      if (lastInvalidation.current === revision) return;
      // A daemon restart may reset either counter. Invalidations are hints and
      // reads remain authoritative, so reject only exact redelivery.
      lastInvalidation.current = revision;
      if (invalidationTimer.current !== undefined) clearTimeout(invalidationTimer.current);
      invalidationTimer.current = setTimeout(() => {
        invalidationTimer.current = undefined;
        if (activeRead.current !== undefined) {
          pendingInvalidation.current = true;
          return;
        }
        setLocalReloads((count) => count + 1);
      }, INVALIDATION_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (invalidationTimer.current !== undefined) clearTimeout(invalidationTimer.current);
      invalidationTimer.current = undefined;
    };
  }, [runtime, lifecycle.active, readable, connectionId]);

  useEffect(() => {
    if (!lifecycle.active || !readable) return;
    const timer = setInterval(() => {
      if (activeRead.current === undefined) setLocalReloads((count) => count + 1);
    }, FALLBACK_REFRESH_MS);
    return () => clearInterval(timer);
  }, [lifecycle.active, readable]);

  return null;
}

export function useOverview(): OverviewStore {
  const store = useContext(OverviewContext);
  if (!store) throw new Error("Overview provider is missing");
  return store;
}
