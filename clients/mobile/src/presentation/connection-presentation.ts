import type { ConnectionAvailability } from "../application/ports";

/// What a saved Mac's availability means to a reader, and whether the app may keep
/// showing that Mac's projections.
///
/// The dot vocabulary is separate from `RowTone` on purpose. A tone answers "does
/// this row want something from you"; a connection dot answers "can this app talk
/// to that machine at all", which is a different question and must not borrow the
/// attention hue that a waiting agent has earned.
export type ConnectionDot = "connected" | "connecting" | "offline" | "needsAttention";

export type ConnectionBlock = "offline" | "revoked" | "updateRequired";

export interface ConnectionPresentation {
  dot: ConnectionDot;
  label: string;
  /// One sentence for the card body and the accessible name.
  summary: string;
  /// When set, this Mac's projections must not be shown as if they were current,
  /// and the screen renders the matching blocked surface instead.
  block: ConnectionBlock | undefined;
}

const presentation: Record<ConnectionAvailability, ConnectionPresentation> = {
  online: {
    dot: "connected",
    label: "Connected",
    summary: "Connected.",
    block: undefined,
  },
  reconnecting: {
    dot: "connecting",
    label: "Reconnecting",
    summary: "Trying to reach this Mac again. Showing its last known data meanwhile.",
    block: undefined,
  },
  offline: {
    dot: "offline",
    label: "Offline",
    summary: "This Mac is not reachable right now. Reconnecting automatically…",
    block: "offline",
  },
  revoked: {
    dot: "needsAttention",
    label: "Needs re-pairing",
    summary: "This phone's access was removed on the Mac. Pair it again to reconnect.",
    block: "revoked",
  },
  /// Never offers "connect anyway". A build that cannot decode the daemon's exact
  /// current contract has nothing safe to say about its state, and guessing is how
  /// a client starts inventing product truth.
  updateRequired: {
    dot: "needsAttention",
    label: "Update required",
    summary: "This Mac runs a different TermLoop contract than this app, so they cannot talk safely.",
    block: "updateRequired",
  },
};

export function connectionPresentation(availability: ConnectionAvailability): ConnectionPresentation {
  return presentation[availability];
}

export interface ConnectionBlockCopy {
  title: string;
  body: string;
  /// What the user does next, always on the Mac or in the app store — never a
  /// bypass.
  resolution: string;
}

const blockCopy: Record<ConnectionBlock, ConnectionBlockCopy> = {
  offline: {
    title: "Not connected",
    body: "This Mac is not reachable right now, so its projects are not shown.",
    resolution: "Reconnecting automatically. Keep Tailscale connected and make sure the Mac is awake with TermLoop running.",
  },
  revoked: {
    title: "Needs re-pairing",
    body: "This phone's access was removed on the Mac, so it can no longer read anything from it.",
    resolution: "Pair this phone again from TermLoop on your Mac.",
  },
  updateRequired: {
    title: "Update required",
    body: "This Mac runs a different TermLoop contract than this app, so they cannot talk safely.",
    resolution: "Update TermLoop Mobile, then reconnect.",
  },
};

export function connectionBlockCopy(block: ConnectionBlock): ConnectionBlockCopy {
  return blockCopy[block];
}

/// A contract identity is 71 characters of hex and unreadable in full on a phone.
/// The mismatch screen still has to show enough of both sides that a reader can
/// tell they differ, so the prefix is kept rather than replaced with a word.
export function shortContractIdentity(identity: string): string {
  const separator = identity.indexOf(":");
  if (separator < 0) return `${identity.slice(0, 12)}…`;
  return `${identity.slice(0, separator + 1)}${identity.slice(separator + 1, separator + 9)}…`;
}
