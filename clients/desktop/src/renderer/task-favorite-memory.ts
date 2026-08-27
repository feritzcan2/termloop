/// Client-local Task favorites. Favoriting changes only the active tab order;
/// Task lifecycle and durable product state remain owned by Core.
const TASK_FAVORITE_KEY = "termloop.taskFavorite.v1";
const MAX_FAVORITES_PER_PROJECT = 256;

type FavoriteStore = Partial<Record<string, string[]>>;

function readStore(storage: Pick<Storage, "getItem"> | undefined): FavoriteStore {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(TASK_FAVORITE_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: FavoriteStore = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!projectId || !Array.isArray(value)) continue;
      const taskIds = [...new Set(value.filter((taskId): taskId is string => typeof taskId === "string" && Boolean(taskId)))]
        .slice(0, MAX_FAVORITES_PER_PROJECT);
      if (taskIds.length > 0) store[projectId] = taskIds;
    }
    return store;
  } catch {
    return {};
  }
}

export function readFavoriteTaskIds(
  projectId: string | undefined,
  storage?: Pick<Storage, "getItem">,
): ReadonlySet<string> {
  if (!projectId) return new Set();
  return new Set(readStore(storage)[projectId] ?? []);
}

export function writeFavoriteTaskIds(
  projectId: string | undefined,
  taskIds: ReadonlySet<string>,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  if (!projectId) return;
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return;
    const store = readStore(source);
    const favorites = [...taskIds].filter(Boolean).slice(0, MAX_FAVORITES_PER_PROJECT);
    if (favorites.length > 0) store[projectId] = favorites;
    else delete store[projectId];
    source.setItem(TASK_FAVORITE_KEY, JSON.stringify(store));
  } catch {
    // A blocked or full preference store must not make the Task rail unusable.
  }
}
