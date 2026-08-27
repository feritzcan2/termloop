import type { AgentStatus, Session } from "./model.js";
import { agentLastKnownActivityAtEpochMs } from "./session-presentation.js";

export type ActiveAgentActivityMemory = Readonly<
  Record<string, Readonly<Record<string, number>>>
>;

const ACTIVE_AGENT_ACTIVITY_KEY = "termloop.activeAgentActivity.v1";
const MAX_PROJECT_AGENT_ACTIVITIES = 512;

function validEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function readActiveAgentActivityMemory(
  storage?: Pick<Storage, "getItem">,
): ActiveAgentActivityMemory {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(ACTIVE_AGENT_ACTIVITY_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const memory: Record<string, Readonly<Record<string, number>>> = {};
    for (const [projectId, value] of Object.entries(parsed)) {
      if (projectId.length === 0 || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const activities: Record<string, number> = {};
      for (const [sessionId, epochMs] of Object.entries(value)) {
        if (sessionId.length > 0 && validEpochMs(epochMs)) activities[sessionId] = epochMs;
      }
      if (Object.keys(activities).length > 0) memory[projectId] = activities;
    }
    return memory;
  } catch {
    return {};
  }
}

export function updateActiveAgentActivityMemory(
  memory: ActiveAgentActivityMemory,
  projectId: string,
  sessions: readonly Session[],
  statuses: readonly AgentStatus[],
): ActiveAgentActivityMemory {
  const agentIds = new Set(sessions.filter((session) => session.kind === "Agent").map((session) => session.id));
  // An empty projection can be a transient reconnect snapshot. Keep the bounded
  // cache until a non-empty authoritative Session list can safely prune it.
  if (projectId.length === 0 || agentIds.size === 0) return memory;

  const previous = memory[projectId] ?? {};
  const statusesById = new Map(statuses.map((status) => [status.sessionId, status]));
  const nextProject: Record<string, number> = {};
  for (const sessionId of agentIds) {
    const previousEpochMs = previous[sessionId] ?? 0;
    const status = statusesById.get(sessionId);
    const observedEpochMs = agentLastKnownActivityAtEpochMs(status);
    const latestEpochMs = Math.max(previousEpochMs, observedEpochMs);
    if (latestEpochMs > 0) nextProject[sessionId] = latestEpochMs;
  }
  const boundedProject = Object.fromEntries(
    Object.entries(nextProject)
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_PROJECT_AGENT_ACTIVITIES),
  );
  const unchanged = Object.keys(previous).length === Object.keys(boundedProject).length
    && Object.entries(boundedProject).every(([sessionId, epochMs]) => previous[sessionId] === epochMs);
  if (unchanged) return memory;

  const next = { ...memory } as Record<string, Readonly<Record<string, number>>>;
  if (Object.keys(boundedProject).length > 0) next[projectId] = boundedProject;
  else delete next[projectId];
  return next;
}

export function writeActiveAgentActivityMemory(
  memory: ActiveAgentActivityMemory,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(ACTIVE_AGENT_ACTIVITY_KEY, JSON.stringify(memory));
  } catch {
    // Sorting still works for this process when storage is blocked or full.
  }
}
