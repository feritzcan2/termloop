export interface ObservedNetwork {
  readonly isConnected: boolean | undefined;
  readonly type: string | undefined;
}

export type NetworkRevivalReason = "networkRestored" | "networkHandoff";

/// Network bursts and the foreground reset often arrive together; one fresh
/// transport per burst is enough.
export const NETWORK_REVIVAL_QUIET_MS = 3_000;

/// A Wi-Fi to cellular handoff kills the old TCP path without closing the
/// WebSocket, so a type change while staying connected is as much a revival
/// signal as coming back online. Losing the network is not: reconnecting then
/// can only fail.
export function networkRevivalReason(
  previous: ObservedNetwork | undefined,
  next: ObservedNetwork,
): NetworkRevivalReason | undefined {
  if (previous === undefined || next.isConnected !== true) return undefined;
  if (previous.isConnected !== true) return "networkRestored";
  return previous.type !== next.type ? "networkHandoff" : undefined;
}
