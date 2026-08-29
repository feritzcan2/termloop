import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
  type PropsWithChildren,
} from "react";
import { AppState } from "react-native";

import { reduceAppLifecycle, type AppLifecycleMachine } from "./app-lifecycle-state";
import { mobileDiagnostics } from "./mobile-diagnostics";

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
    const subscription = AppState.addEventListener("change", (nativeState) => {
      const previous = observed;
      observed = reduceAppLifecycle(observed, nativeState);
      const backgroundDurationMs = previous.backgrounded && !observed.backgrounded
        && backgroundStartedAtEpochMs !== undefined
        ? Math.max(0, Date.now() - backgroundStartedAtEpochMs)
        : undefined;
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
      });
      if (!previous.backgrounded && observed.backgrounded) {
        backgroundStartedAtEpochMs = Date.now();
        mobileDiagnostics.report("lifecycle", "backgrounded");
      } else if (previous.backgrounded && !observed.backgrounded) {
        mobileDiagnostics.report("lifecycle", "foregrounded", {
          backgroundDurationMs: backgroundStartedAtEpochMs === undefined
            ? undefined : backgroundDurationMs,
          foregroundRevision: observed.foregroundRevision,
        });
        backgroundStartedAtEpochMs = undefined;
      }
      dispatch(nativeState);
    });
    return () => {
      mobileDiagnostics.report("lifecycle", "provider_unmounted", {
        active: observed.active,
        backgrounded: observed.backgrounded,
        foregroundRevision: observed.foregroundRevision,
      });
      subscription.remove();
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
