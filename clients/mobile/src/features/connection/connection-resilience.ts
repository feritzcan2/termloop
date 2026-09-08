import type { ConnectionProfile } from "../../application/ports";
import { connectionPresentation } from "../../presentation/connection-presentation";

export interface ConnectionLifecycle {
  readonly active: boolean;
  readonly foregroundRevision: number;
}

/// React Native may deliver background and foreground transitions in one batch
/// after JavaScript resumes. Comparing revisions makes the fresh-transport reset
/// deterministic even when no render committed while the app was suspended.
export function shouldResetConnectionTransports(
  previous: ConnectionLifecycle,
  current: ConnectionLifecycle,
): boolean {
  return !current.active || current.foregroundRevision !== previous.foregroundRevision;
}

/// Prefer the most recently connected readable Mac, but always fall back to a
/// saved one. A temporary network failure must not erase the selected computer
/// and make the entire app look unpaired.
export function preferredConnectionId(profiles: readonly ConnectionProfile[]): string | undefined {
  const recentFirst = [...profiles]
    .sort((left, right) => (right.lastConnectedAtEpochMs ?? 0) - (left.lastConnectedAtEpochMs ?? 0));
  const usable = recentFirst
    .filter((profile) => connectionPresentation(profile.availability).block === undefined);
  return usable[0]?.id ?? recentFirst[0]?.id;
}

/// The offline label must not retire recovery for the Mac the user is viewing.
/// Other offline Macs keep the slower catalog polling cadence.
export function needsConnectionRecovery(
  profiles: readonly ConnectionProfile[],
  selectedId: string | undefined,
): boolean {
  return profiles.some((profile) => profile.availability === "reconnecting"
    || (profile.id === selectedId && profile.availability === "offline"));
}
