export type ActiveAgentFavorites = Readonly<Record<string, readonly string[]>>;

const ACTIVE_AGENT_FAVORITES_KEY = "termloop.activeAgentFavorites.v1";

export function readActiveAgentFavorites(storage?: Pick<Storage, "getItem">): ActiveAgentFavorites {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return {};
    const parsed = JSON.parse(source.getItem(ACTIVE_AGENT_FAVORITES_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([projectId, value]) => {
      if (projectId.length === 0 || !Array.isArray(value)) return [];
      const sessionIds = [...new Set(value.filter((sessionId): sessionId is string => typeof sessionId === "string" && sessionId.length > 0))];
      return sessionIds.length > 0 ? [[projectId, sessionIds]] : [];
    }));
  } catch {
    return {};
  }
}

export function toggleActiveAgentFavorite(
  favorites: ActiveAgentFavorites,
  projectId: string,
  sessionId: string,
): ActiveAgentFavorites {
  const current = favorites[projectId] ?? [];
  const next = current.includes(sessionId)
    ? current.filter((candidate) => candidate !== sessionId)
    : [...current, sessionId];
  const projects = { ...favorites } as Record<string, readonly string[]>;
  if (next.length > 0) projects[projectId] = next;
  else delete projects[projectId];
  return projects;
}

export function writeActiveAgentFavorites(
  favorites: ActiveAgentFavorites,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(ACTIVE_AGENT_FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    // A blocked or full preference store must not make the agent rail unusable.
  }
}

export function persistActiveAgentFavoriteToggle(
  favorites: ActiveAgentFavorites,
  projectId: string,
  sessionId: string,
  storage?: Pick<Storage, "setItem">,
): ActiveAgentFavorites {
  const next = toggleActiveAgentFavorite(favorites, projectId, sessionId);
  writeActiveAgentFavorites(next, storage);
  return next;
}
