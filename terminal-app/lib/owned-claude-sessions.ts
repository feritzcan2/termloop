/**
 * Tracks which Claude sessions this mobile app currently "owns" — i.e. has an
 * active SSH `claude --resume` running. Used by the teleport UI to pick
 * between "Teleport here" (Mac owns) and "Teleport to Mac" (mobile owns).
 *
 * In-memory store. On cold start we repopulate it from the persisted terminal
 * resume stack so teleport buttons still reflect the mobile-owned sessions.
 */

type ListenerFn = () => void;

export interface OwnedSession {
  workspaceId: string;
  sessionId: string;
  claimedAt: number;
}

const owned = new Map<string, OwnedSession>();
const listeners = new Set<ListenerFn>();

function emit() {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // listener threw — swallow to keep others firing
    }
  }
}

export function claim(workspaceId: string, sessionId: string): void {
  owned.set(workspaceId, { workspaceId, sessionId, claimedAt: Date.now() });
  emit();
}

export function release(workspaceId: string): void {
  if (owned.delete(workspaceId)) emit();
}

export function releaseAll(): void {
  if (owned.size === 0) return;
  owned.clear();
  emit();
}

export function replaceAll(
  sessions: Iterable<Pick<OwnedSession, 'workspaceId' | 'sessionId'>>
): void {
  const next = new Map<string, OwnedSession>();
  for (const session of sessions) {
    next.set(session.workspaceId, {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      claimedAt: Date.now(),
    });
  }

  if (next.size === owned.size) {
    let changed = false;
    for (const [workspaceId, session] of next) {
      if (owned.get(workspaceId)?.sessionId !== session.sessionId) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
  }

  owned.clear();
  for (const [workspaceId, session] of next) {
    owned.set(workspaceId, session);
  }
  emit();
}

export function isOwned(workspaceId: string): boolean {
  return owned.has(workspaceId);
}

export function getOwned(workspaceId: string): OwnedSession | undefined {
  return owned.get(workspaceId);
}

export function subscribe(cb: ListenerFn): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
