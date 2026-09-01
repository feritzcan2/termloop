export type MobileAppState = "active" | "background" | "inactive" | "unknown" | "extension";

export interface AppLifecycleMachine {
  readonly active: boolean;
  readonly backgrounded: boolean;
  readonly foregroundRevision: number;
}

export interface AppLifecycleAction {
  readonly nativeState: MobileAppState;
  readonly resumeAfterGap?: boolean;
}

export const SUSPENSION_GAP_MS = 10_000;

export function reduceAppLifecycle(
  current: AppLifecycleMachine,
  action: MobileAppState | AppLifecycleAction,
): AppLifecycleMachine {
  const next = typeof action === "string" ? action : action.nativeState;
  const resumeAfterGap = typeof action === "string" ? false : action.resumeAfterGap === true;
  /// iOS moves through `inactive` while system UI such as PHPicker, the camera,
  /// Control Centre, or an interruption owns focus. That is not evidence that the
  /// app entered the background, and tearing down sockets here makes attaching a
  /// photo immediately present as a lost Mac connection.
  if (next === "inactive") return current;
  if (next === "background") {
    if (current.backgrounded && !current.active) return current;
    return { ...current, active: false, backgrounded: true };
  }
  if (next !== "active") return current;
  if (!current.backgrounded && current.active && !resumeAfterGap) return current;
  return {
    active: true,
    backgrounded: false,
    foregroundRevision: current.foregroundRevision + 1,
  };
}

/// Native background and foreground events can both be lost while iOS suspends
/// JavaScript. A delayed heartbeat while native state is active is the only
/// evidence available in that case. `inactive` alone still never causes a reset.
export function shouldInferForegroundAfterGap(
  current: AppLifecycleMachine,
  nativeState: MobileAppState,
  javascriptGapMs: number,
): boolean {
  return current.active
    && !current.backgrounded
    && nativeState === "active"
    && javascriptGapMs >= SUSPENSION_GAP_MS;
}
