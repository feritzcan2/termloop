/// Last chosen worktree parent folder per Project, so create dialogs can
/// propose the same destination family across app restarts. Client-local
/// convenience only — never authority over where a worktree may be created;
/// every path still goes through the daemon's provisioning gates.
const WORKTREE_PARENT_KEY = "termloop.worktreeParent.v1";
const MAX_PROJECTS = 32;

type ParentStore = Partial<Record<string, string>>;

function readStore(storage: Pick<Storage, "getItem"> | undefined): ParentStore {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(WORKTREE_PARENT_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function readWorktreeParentPath(
  projectId: string | undefined,
  storage?: Pick<Storage, "getItem">,
): string | undefined {
  if (!projectId) return undefined;
  return readStore(storage)[projectId];
}

export function writeWorktreeParentPath(
  projectId: string | undefined,
  parentPath: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  if (!projectId || !parentPath.trim()) return;
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return;
    const store = readStore(source);
    delete store[projectId];
    /// Re-inserting last keeps insertion order as a recency order, so the cap
    /// below drops the longest-untouched Projects first.
    const entries = [...Object.entries(store), [projectId, parentPath.trim()] as const];
    source.setItem(WORKTREE_PARENT_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_PROJECTS))));
  } catch {
    /* Storage unavailable — the in-session suggestion still works. */
  }
}
