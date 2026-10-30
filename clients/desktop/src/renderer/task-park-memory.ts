/// Client-local parked Tasks. Parking only folds a Task and sinks it to the end
/// of the active board; Task lifecycle and durable state remain owned by Core.
const TASK_PARKED_KEY = "termloop.taskParked.v1";
const MAX_PARKED_PER_PROJECT = 256;

type ParkedStore = Partial<Record<string, string[]>>;

function readStore(storage: Pick<Storage, "getItem"> | undefined): ParkedStore {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(TASK_PARKED_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: ParkedStore = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!projectId || !Array.isArray(value)) continue;
      const taskIds = [...new Set(value.filter((taskId): taskId is string => typeof taskId === "string" && Boolean(taskId)))]
        .slice(0, MAX_PARKED_PER_PROJECT);
      if (taskIds.length > 0) store[projectId] = taskIds;
    }
    return store;
  } catch {
    return {};
  }
}

export function readParkedTaskIds(
  projectId: string | undefined,
  storage?: Pick<Storage, "getItem">,
): ReadonlySet<string> {
  if (!projectId) return new Set();
  return new Set(readStore(storage)[projectId] ?? []);
}

export function writeParkedTaskIds(
  projectId: string | undefined,
  taskIds: ReadonlySet<string>,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  if (!projectId) return;
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return;
    const store = readStore(source);
    const parked = [...taskIds].filter(Boolean).slice(0, MAX_PARKED_PER_PROJECT);
    if (parked.length > 0) store[projectId] = parked;
    else delete store[projectId];
    source.setItem(TASK_PARKED_KEY, JSON.stringify(store));
  } catch {
    // A blocked or full preference store must not make the Task rail unusable.
  }
}
