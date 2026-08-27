/// Client-local Task disclosure preferences. This is presentation state only;
/// Task status remains owned by Core and is used only as the default when no
/// preference has been recorded yet.
const TASK_COLLAPSE_KEY = "termloop.taskCollapse.v1";

type CollapseStore = Partial<Record<string, Partial<Record<string, boolean>>>>;

function readStore(storage: Pick<Storage, "getItem"> | undefined): CollapseStore {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(TASK_COLLAPSE_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: CollapseStore = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!projectId || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const tasks = Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, boolean] => Boolean(entry[0]) && typeof entry[1] === "boolean"));
      if (Object.keys(tasks).length > 0) store[projectId] = tasks;
    }
    return store;
  } catch {
    return {};
  }
}

export function readTaskCollapsed(
  projectId: string | undefined,
  taskId: string,
  defaultCollapsed: boolean,
  storage?: Pick<Storage, "getItem">,
): boolean {
  if (!projectId || !taskId) return defaultCollapsed;
  return readStore(storage)[projectId]?.[taskId] ?? defaultCollapsed;
}

export function writeTaskCollapsed(
  projectId: string | undefined,
  taskId: string,
  collapsed: boolean,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  if (!projectId || !taskId) return;
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return;
    const store = readStore(source);
    store[projectId] = { ...store[projectId], [taskId]: collapsed };
    source.setItem(TASK_COLLAPSE_KEY, JSON.stringify(store));
  } catch {
    // A blocked or full preference store must not make the Task rail unusable.
  }
}
