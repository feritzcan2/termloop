/// Recently opened worktree-relative files per Project (for example a `.sln`),
/// so every Task worktree menu of that Project can offer them again across app
/// restarts. Client-local convenience only — main re-resolves each path inside
/// the daemon-read worktree before opening it.
const WORKTREE_FILE_KEY = "termloop.worktreeFiles.v1";
const MAX_PROJECTS = 32;
export const MAX_REMEMBERED_WORKTREE_FILES = 3;

type FileStore = Partial<Record<string, string[]>>;

function readStore(storage: Pick<Storage, "getItem"> | undefined): FileStore {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(WORKTREE_FILE_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
      .map(([projectId, files]) => [
        projectId,
        Array.isArray(files)
          ? files.filter((file): file is string => typeof file === "string" && file.trim().length > 0)
            .slice(0, MAX_REMEMBERED_WORKTREE_FILES)
          : [],
      ] as const)
      .filter((entry) => entry[1].length > 0);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function readWorktreeFiles(
  projectId: string | undefined,
  storage?: Pick<Storage, "getItem">,
): readonly string[] {
  if (!projectId) return [];
  return readStore(storage)[projectId] ?? [];
}

/// Moves `relativePath` to the front of the Project's list and returns the
/// updated list, so callers can refresh their state from the same value.
export function rememberWorktreeFile(
  projectId: string | undefined,
  relativePath: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
): readonly string[] {
  if (!projectId || !relativePath.trim()) return readWorktreeFiles(projectId, storage);
  const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  const store = readStore(source);
  const files = [relativePath, ...(store[projectId] ?? []).filter((file) => file !== relativePath)]
    .slice(0, MAX_REMEMBERED_WORKTREE_FILES);
  try {
    if (source) {
      delete store[projectId];
      /// Re-inserting last keeps insertion order as a recency order, so the cap
      /// below drops the longest-untouched Projects first.
      const entries = [...Object.entries(store), [projectId, files] as const];
      source.setItem(WORKTREE_FILE_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_PROJECTS))));
    }
  } catch {
    /* Storage unavailable — the in-session list still works. */
  }
  return files;
}
