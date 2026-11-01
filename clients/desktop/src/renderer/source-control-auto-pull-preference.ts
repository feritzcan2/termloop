/// Client-local Source Control preference: whether the visible checkout
/// fetches and fast-forwards from its upstream on its own. Core owns none of
/// it; a blocked store only forgets the choice.
const AUTO_PULL_KEY = "termloop.sourceControl.autoPull.v1";

export function readSourceControlAutoPull(storage?: Pick<Storage, "getItem">): boolean {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    return source?.getItem(AUTO_PULL_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSourceControlAutoPull(enabled: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(AUTO_PULL_KEY, enabled ? "true" : "false");
  } catch {
    // An unavailable preference store must not prevent in-session use.
  }
}
