import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
  type PropsWithChildren,
} from "react";
import { AppState } from "react-native";

import {
  reduceAppLifecycle,
  shouldInferForegroundAfterGap,
  type AppLifecycleAction,
  type AppLifecycleMachine,
  type MobileAppState,
} from "./app-lifecycle-state";
import { mobileDiagnostics } from "./mobile-diagnostics";
import { subscribeNetworkRevival } from "./network-revival";
import { NETWORK_REVIVAL_QUIET_MS, type NetworkRevivalReason } from "./network-revival-state";

const SUSPENSION_PROBE_MS = 5_000;

export interface AppLifecycleState {
  readonly active: boolean;
  readonly foregroundRevision: number;
}

const AppLifecycleContext = createContext<AppLifecycleState | undefined>(undefined);

/**
 * Owns the app's one native lifecycle subscription above the navigation stack.
 * Retained or frozen routes must consume the same foreground revision: a listener
 * mounted inside each route can miss the resume that should repair its terminal.
 */
export function AppLifecycleProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(reduceAppLifecycle, AppState.currentState, (current): AppLifecycleMachine => ({
    active: current !== "background",
    backgrounded: current === "background",
    foregroundRevision: 0,
  }));

  useEffect(() => {
    let observed = state;
    let backgroundStartedAtEpochMs = observed.backgrounded ? Date.now() : undefined;
    let lastJavascriptHeartbeatAtEpochMs = Date.now();
    let lastNativeState = AppState.currentState as MobileAppState;
    let lastTransportRevisionAtEpochMs = Date.now();
    mobileDiagnostics.updateLifecycle({
      nativeState: AppState.currentState,
      foregroundRevision: observed.foregroundRevision,
    });
    mobileDiagnostics.report("lifecycle", "initialized", {
      nativeState: AppState.currentState,
      active: observed.active,
      backgrounded: observed.backgrounded,
      foregroundRevision: observed.foregroundRevision,
    });
    const transition = (
      nativeState: MobileAppState,
      resumeAfterGap: boolean,
      javascriptGapMs?: number,
      networkRevival?: NetworkRevivalReason,
    ) => {
      const previous = observed;
      const action: AppLifecycleAction = {
        nativeState,
        resumeAfterGap,
        ...(networkRevival === undefined ? {} : { networkRevived: true }),
      };
      observed = reduceAppLifecycle(observed, action);
      if (observed.foregroundRevision !== previous.foregroundRevision) {
        lastTransportRevisionAtEpochMs = Date.now();
      }
      const backgroundDurationMs = previous.backgrounded && !observed.backgrounded
        && backgroundStartedAtEpochMs !== undefined
        ? Math.max(0, Date.now() - backgroundStartedAtEpochMs)
        : resumeAfterGap ? javascriptGapMs : undefined;
      mobileDiagnostics.updateLifecycle({
        nativeState,
        foregroundRevision: observed.foregroundRevision,
        ...(backgroundDurationMs === undefined ? {} : { backgroundDurationMs }),
      });
      mobileDiagnostics.report("lifecycle", "native_state", {
        nativeState,
        previousActive: previous.active,
        nextActive: observed.active,
        backgrounded: observed.backgrounded,
        foregroundRevision: observed.foregroundRevision,
        changed: observed !== previous,
        resumeAfterGap,
        javascriptGapMs,
        networkRevival,
      });
      if (!previous.backgrounded && observed.backgrounded) {
        backgroundStartedAtEpochMs = Date.now();
        mobileDiagnostics.report("lifecycle", "backgrounded");
      } else if ((previous.backgrounded && !observed.backgrounded) || resumeAfterGap) {
        mobileDiagnostics.report("lifecycle", "foregrounded", {
          backgroundDurationMs,
          foregroundRevision: observed.foregroundRevision,
        });
        backgroundStartedAtEpochMs = undefined;
      } else if (networkRevival !== undefined && observed !== previous) {
        mobileDiagnostics.report("lifecycle", "network_revived", {
          reason: networkRevival,
          foregroundRevision: observed.foregroundRevision,
        });
      }
      dispatch(action);
    };
    const observe = (nativeState: MobileAppState) => {
      const now = Date.now();
      const javascriptGapMs = Math.max(0, now - lastJavascriptHeartbeatAtEpochMs);
      const resumeAfterGap = shouldInferForegroundAfterGap(
        observed,
        nativeState,
        javascriptGapMs,
      );
      lastJavascriptHeartbeatAtEpochMs = now;
      lastNativeState = nativeState;
      transition(nativeState, resumeAfterGap, resumeAfterGap ? javascriptGapMs : undefined);
    };
    const subscription = AppState.addEventListener("change", observe);
    /// A network return or Wi-Fi/cellular handoff while the app stays open leaves
    /// sockets on a dead path that otherwise lingers until the inbound liveness
    /// timeout. Reuse the foreground revision so every transport, overview read,
    /// and terminal attachment repairs through the one tested resume path.
    const unsubscribeNetwork = subscribeNetworkRevival((reason) => {
      const nativeState = AppState.currentState as MobileAppState;
      if (nativeState !== "active" || !observed.active) return;
      if (Date.now() - lastTransportRevisionAtEpochMs < NETWORK_REVIVAL_QUIET_MS) return;
      lastNativeState = nativeState;
      transition(nativeState, false, undefined, reason);
    });
    const suspensionProbe = setInterval(() => {
      const nativeState = AppState.currentState as MobileAppState;
      const now = Date.now();
      const javascriptGapMs = Math.max(0, now - lastJavascriptHeartbeatAtEpochMs);
      const resumeAfterGap = shouldInferForegroundAfterGap(
        observed,
        nativeState,
        javascriptGapMs,
      );
      lastJavascriptHeartbeatAtEpochMs = now;
      if (resumeAfterGap || nativeState !== lastNativeState) {
        lastNativeState = nativeState;
        transition(nativeState, resumeAfterGap, resumeAfterGap ? javascriptGapMs : undefined);
      }
    }, SUSPENSION_PROBE_MS);
    return () => {
      clearInterval(suspensionProbe);
      subscription.remove();
      unsubscribeNetwork();
      mobileDiagnostics.report("lifecycle", "provider_unmounted", {
        active: observed.active,
        backgrounded: observed.backgrounded,
        foregroundRevision: observed.foregroundRevision,
      });
    };
  }, []);

  return createElement(AppLifecycleContext.Provider, {
    value: { active: state.active, foregroundRevision: state.foregroundRevision },
  }, children);
}

export function useAppLifecycle(): AppLifecycleState {
  const state = useContext(AppLifecycleContext);
  if (state === undefined) throw new Error("App lifecycle provider is missing");
  return state;
}
