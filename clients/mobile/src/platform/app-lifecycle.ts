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
    const subscription = AppState.addEventListener("change", dispatch);
    return () => subscription.remove();
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
