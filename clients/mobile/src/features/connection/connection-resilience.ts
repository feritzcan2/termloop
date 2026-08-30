import type { ConnectionProfile } from "../../application/ports";
import { connectionPresentation } from "../../presentation/connection-presentation";

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
