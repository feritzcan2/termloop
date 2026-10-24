/// Client-local switch for the experimental Project Manager mode. While it is
/// off, nothing about Project modes is shown and every Project behaves as a
/// Developer Project, whatever the daemon has stored.
const STORAGE_KEY = "termloop.experimental.projectManagerMode.v1";
const listeners = new Set<() => void>();
let current: boolean | undefined;

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readProjectManagerModeFlag(
  storage: Pick<Storage, "getItem"> | undefined = browserStorage(),
): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function projectManagerModeEnabled(): boolean {
  current ??= readProjectManagerModeFlag();
  return current;
}

export function setProjectManagerModeEnabled(
  enabled: boolean,
  storage: Pick<Storage, "setItem"> | undefined = browserStorage(),
): void {
  current = enabled;
  try {
    storage?.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // The flag still applies for this window when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function subscribeProjectManagerModeFlag(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
