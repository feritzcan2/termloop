/// Last chosen worktree base ref per Project, shared by every worktree-create
/// dialog so a deliberate selection survives dialog and application restarts.
/// Client-local convenience only: the remembered ref is used only when the
/// daemon's current local-branch list still contains it.
const WORKTREE_BASE_REF_KEY = "termloop.worktreeBaseRef.v1";
const MAX_PROJECTS = 32;

type BaseRefStore = Partial<Record<string, string>>;

function readStore(storage: Pick<Storage, "getItem"> | undefined): BaseRefStore {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(WORKTREE_BASE_REF_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function readWorktreeBaseRef(
  projectId: string | undefined,
  storage?: Pick<Storage, "getItem">,
): string | undefined {
  if (!projectId) return undefined;
  return readStore(storage)[projectId];
}

export function writeWorktreeBaseRef(
  projectId: string | undefined,
  baseRef: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  if (!projectId || !baseRef.trim()) return;
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return;
    const store = readStore(source);
    delete store[projectId];
    const entries = [...Object.entries(store), [projectId, baseRef.trim()] as const];
    source.setItem(WORKTREE_BASE_REF_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_PROJECTS))));
  } catch {
    /* Storage unavailable — the in-session selection still works. */
  }
}
