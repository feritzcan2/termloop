/// The experimental Project Manager mode used to be a client-local switch.
/// The daemon owns it now; a computer that had turned the old switch on hands
/// that choice to its daemon once, and the old value is forgotten.
const LEGACY_STORAGE_KEY = "termloop.experimental.projectManagerMode.v1";

function browserStorage(): Pick<Storage, "getItem" | "removeItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/// Whether the old client-local switch was on. Reading it forgets it, so the
/// choice is handed over at most once.
export function takeLegacyProjectManagerModeFlag(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined = browserStorage(),
): boolean {
  try {
    const enabled = storage?.getItem(LEGACY_STORAGE_KEY) === "on";
    storage?.removeItem(LEGACY_STORAGE_KEY);
    return enabled;
  } catch {
    return false;
  }
}
