export type MobileAppState = "active" | "background" | "inactive" | "unknown" | "extension";

export interface AppLifecycleMachine {
  readonly active: boolean;
  readonly backgrounded: boolean;
  readonly foregroundRevision: number;
}

export function reduceAppLifecycle(
  current: AppLifecycleMachine,
  next: MobileAppState,
): AppLifecycleMachine {
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
  if (!current.backgrounded && current.active) return current;
  return {
    active: true,
    backgrounded: false,
    foregroundRevision: current.foregroundRevision + (current.backgrounded ? 1 : 0),
  };
}
