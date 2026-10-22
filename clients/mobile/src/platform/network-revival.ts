import { requireOptionalNativeModule } from "expo";

import { mobileDiagnostics } from "./mobile-diagnostics";
import { networkRevivalReason, type NetworkRevivalReason, type ObservedNetwork } from "./network-revival-state";

/// Reports OS evidence that a dead network path probably came back.
///
/// Over-the-air updates share a runtime with binaries built before ExpoNetwork
/// existed, and importing `expo-network` there throws during module evaluation.
/// Those builds keep the foreground and liveness recovery they already had.
export function subscribeNetworkRevival(listener: (reason: NetworkRevivalReason) => void): () => void {
  if (requireOptionalNativeModule("ExpoNetwork") === null) {
    mobileDiagnostics.report("lifecycle", "network_revival_unavailable");
    return () => undefined;
  }
  let disposed = false;
  let removeListener: (() => void) | undefined;
  let last: ObservedNetwork | undefined;
  const observe = (next: ObservedNetwork) => {
    const reason = networkRevivalReason(last, next);
    last = next;
    if (reason !== undefined) listener(reason);
  };
  void import("expo-network").then((network) => {
    if (disposed) return;
    const subscription = network.addNetworkStateListener(({ isConnected, type }) => {
      observe({ isConnected, type });
    });
    removeListener = () => subscription.remove();
    // The listener reports only changes. Without a baseline, the first recovery
    // after launching offline would look like an initial observation.
    void network.getNetworkStateAsync().then(({ isConnected, type }) => {
      if (!disposed && last === undefined) last = { isConnected, type };
    }, () => undefined);
  }, (cause: unknown) => {
    mobileDiagnostics.report("lifecycle", "network_revival_unavailable", {
      causeType: cause instanceof Error ? cause.name : typeof cause,
    });
  });
  return () => {
    disposed = true;
    removeListener?.();
  };
}
