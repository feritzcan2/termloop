import { useEffect, useState } from "react";
import { AppState } from "react-native";

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
  const [active, setActive] = useState(AppState.currentState === "active");
  const [foregroundRevision, setForegroundRevision] = useState(0);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const nextActive = next === "active";
      setActive(nextActive);
      if (nextActive) setForegroundRevision((revision) => revision + 1);
    });
    return () => subscription.remove();
  }, []);

  return { active, foregroundRevision };
}
