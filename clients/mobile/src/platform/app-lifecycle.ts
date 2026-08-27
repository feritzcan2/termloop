import { useEffect, useReducer } from "react";
import { AppState } from "react-native";

import { reduceAppLifecycle, type AppLifecycleMachine } from "./app-lifecycle-state";

export interface AppLifecycleState {
  readonly active: boolean;
  readonly foregroundRevision: number;
}

/**
 * Turns the native app lifecycle into a tiny client-local signal. A foreground
 * revision is useful even when React never observed the intermediate suspended
 * state, and no domain or connection state is persisted here.
 */
export function useAppLifecycle(): AppLifecycleState {
  const [state, dispatch] = useReducer(reduceAppLifecycle, AppState.currentState, (current): AppLifecycleMachine => ({
    active: current !== "background",
    backgrounded: current === "background",
    foregroundRevision: 0,
  }));

  useEffect(() => {
    const subscription = AppState.addEventListener("change", dispatch);
    return () => subscription.remove();
  }, []);

  return { active: state.active, foregroundRevision: state.foregroundRevision };
}
