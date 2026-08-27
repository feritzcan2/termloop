/// Client-local Task tab selection. This is presentation state only: Core owns
/// Task status, while the rail remembers which current Task the user was
/// looking at within each Project and status tab.
const TASK_TAB_KEY = "termloop.taskTab.v1";

export type TaskTabStatus = "active" | "closed";

type TaskTabStore = Partial<Record<string, Partial<Record<TaskTabStatus, string>>>>;

function readStore(storage: Pick<Storage, "getItem"> | undefined): TaskTabStore {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(TASK_TAB_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: TaskTabStore = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!projectId || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as Record<string, unknown>;
      const selection: Partial<Record<TaskTabStatus, string>> = {};
      if (typeof candidate.active === "string" && candidate.active) selection.active = candidate.active;
      if (typeof candidate.closed === "string" && candidate.closed) selection.closed = candidate.closed;
      if (selection.active || selection.closed) store[projectId] = selection;
    }
    return store;
  } catch {
    return {};
  }
}

export function readTaskTabSelection(
  projectId: string | undefined,
  status: TaskTabStatus,
  storage?: Pick<Storage, "getItem">,
): string | undefined {
  if (!projectId) return undefined;
  return readStore(storage)[projectId]?.[status];
}

export function writeTaskTabSelection(
  projectId: string | undefined,
  status: TaskTabStatus,
  taskId: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  if (!projectId || !taskId) return;
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return;
    const store = readStore(source);
    store[projectId] = { ...store[projectId], [status]: taskId };
    source.setItem(TASK_TAB_KEY, JSON.stringify(store));
  } catch {
    // A blocked or full preference store must not make the Task rail unusable.
  }
}
