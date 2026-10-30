import type { ConnectionSourceState } from "../connection-profile-types.js";

// Client-local Project ordering. The daemon owns Projects; this only remembers
// the order the user arranged them in so Cmd+1…Cmd+9 and the Project menu
// stay stable on this computer.
const PROJECT_ORDER_KEY = "termloop.projectOrder.v1";

export type ProjectOrder = readonly string[];

type Identified = { readonly id: string };
type Arrangeable = Identified & { readonly connectionState?: ConnectionSourceState };

const offline = (project: Arrangeable): boolean => project.connectionState === "offline";

export function readProjectOrder(storage?: Pick<Storage, "getItem">): ProjectOrder {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return [];
    const parsed = JSON.parse(source.getItem(PROJECT_ORDER_KEY) ?? "null") as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0))];
  } catch {
    return [];
  }
}

export function writeProjectOrder(order: ProjectOrder, storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(PROJECT_ORDER_KEY, JSON.stringify(order));
  } catch {
    // A blocked or full preference store must not make Project switching unusable.
  }
}

// Remembered Projects come first in their remembered order; Projects the order
// has never seen keep the daemon's order after them. Removed Projects vanish.
export function orderProjects<T extends Identified>(projects: readonly T[], order: ProjectOrder): T[] {
  if (order.length === 0) return [...projects];
  const rank = new Map(order.map((id, index) => [id, index]));
  return projects
    .map((project, index) => ({ project, rank: rank.get(project.id) ?? order.length + index }))
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.project);
}

// Projects on offline computers sink below reachable ones. Each side keeps the
// remembered order, so a reconnected computer returns to its arranged place.
export function arrangeProjects<T extends Arrangeable>(projects: readonly T[], order: ProjectOrder): T[] {
  const ordered = orderProjects(projects, order);
  return [...ordered.filter((project) => !offline(project)), ...ordered.filter(offline)];
}

// Produces a complete order over the current Projects with `projectId` moved
// next to `targetId`. Returns the input order unchanged for unknown IDs, and
// for a move across the reachable/offline boundary, which connection state
// owns rather than the arrangement.
export function moveProject<T extends Arrangeable>(
  projects: readonly T[],
  order: ProjectOrder,
  projectId: string,
  targetId: string,
): ProjectOrder {
  const ordered = orderProjects(projects, order);
  const from = ordered.findIndex((project) => project.id === projectId);
  const to = ordered.findIndex((project) => project.id === targetId);
  const source = ordered[from];
  const target = ordered[to];
  if (!source || !target || from === to || offline(source) !== offline(target)) return order;
  const next = ordered.map((project) => project.id);
  next.splice(from, 1);
  next.splice(to, 0, projectId);
  return next;
}

export function moveProjectBy<T extends Arrangeable>(
  projects: readonly T[],
  order: ProjectOrder,
  projectId: string,
  delta: -1 | 1,
): ProjectOrder {
  const arranged = arrangeProjects(projects, order);
  const from = arranged.findIndex((project) => project.id === projectId);
  const target = arranged[from + delta];
  return from < 0 || target === undefined ? order : moveProject(projects, order, projectId, target.id);
}
