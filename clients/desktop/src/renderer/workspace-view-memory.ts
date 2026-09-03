/// Client-local workspace navigation. Each Project remembers the last rail the
/// user chose; Core owns none of this presentation preference.
const WORKSPACE_VIEW_KEY = "termloop.workspaceView.v1";

export type WorkspaceView = "overview" | "agents" | "history" | "steward";
export type WorkspaceViewMemory = Readonly<Record<string, WorkspaceView>>;

function isWorkspaceView(value: unknown): value is WorkspaceView {
  return value === "overview" || value === "agents" || value === "history" || value === "steward";
}

export function readWorkspaceViewMemory(
  storage?: Pick<Storage, "getItem">,
): WorkspaceViewMemory {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(WORKSPACE_VIEW_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const memory: Record<string, WorkspaceView> = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (projectId && isWorkspaceView(value)) memory[projectId] = value;
    }
    return memory;
  } catch {
    return {};
  }
}

export function workspaceViewForProject(
  memory: WorkspaceViewMemory,
  projectId: string | undefined,
): WorkspaceView {
  return projectId ? memory[projectId] ?? "agents" : "agents";
}

export function rememberWorkspaceView(
  memory: WorkspaceViewMemory,
  projectId: string | undefined,
  view: WorkspaceView,
  storage?: Pick<Storage, "setItem">,
): WorkspaceViewMemory {
  if (!projectId) return memory;
  const next = { ...memory, [projectId]: view };
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(WORKSPACE_VIEW_KEY, JSON.stringify(next));
  } catch {
    // A blocked or full preference store must not prevent in-session navigation.
  }
  return next;
}
