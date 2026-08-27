import {
  connectionEntityIdentity,
  connectionEntityKey,
} from "../connection-scope.js";

export const LAYOUT_VERSION = 2 as const;
export const MAX_LAYOUT_PANES = 8;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

export type SplitDirection = "horizontal" | "vertical";
export type SplitPlacement = "before" | "after";

export type PaneNode = {
  type: "pane";
  id: string;
  sessionId: string | null;
};

export type SplitNode = {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
};

export type LayoutNode = PaneNode | SplitNode;

export type ProjectLayout = {
  root: LayoutNode;
  activePaneId: string;
};

export type LayoutDocument = {
  version: typeof LAYOUT_VERSION;
  profiles: Record<string, ProfileLayoutDocument>;
};

export type ProfileLayoutDocument = {
  projects: Record<string, ProjectLayout>;
  sessionOrderByProject: Record<string, string[]>;
  /// User-created peer groups in the sidebar. This remains client-local layout
  /// state: it does not claim a Task, Ask-To, or process relationship.
  agentGroupsByProject?: Record<string, AgentGroupLayout[]>;
  /// Session relationships the user chose to render as independent rows.
  /// Core still owns the relationship and any Ask-To reply routing.
  detachedAgentRelationshipsByProject?: Record<string, string[]>;
};

export type AgentGroupLayout = {
  sessionIds: string[];
  name?: string;
};

type LegacyLayoutDocument = {
  version: 1;
  projects: Record<string, ProjectLayout>;
  sessionOrderByProject: Record<string, string[]>;
};

type IdFactory = () => string;

export function emptyLayoutDocument(): LayoutDocument {
  return { version: LAYOUT_VERSION, profiles: {} };
}

export function createProjectLayout(sessionId: string | null = null, createId: IdFactory = defaultId): ProjectLayout {
  const pane = createPane(sessionId, createId);
  return { root: pane, activePaneId: pane.id };
}

export function panes(layout: ProjectLayout): PaneNode[] {
  return collectPanes(layout.root);
}

export function activePane(layout: ProjectLayout): PaneNode {
  const ordered = panes(layout);
  const pane = ordered.find((candidate) => candidate.id === layout.activePaneId) ?? ordered[0];
  if (!pane) throw new Error("layout has no panes");
  return pane;
}

export function paneForSession(layout: ProjectLayout, sessionId: string): PaneNode | undefined {
  return panes(layout).find((pane) => pane.sessionId === sessionId);
}

export function focusPane(layout: ProjectLayout, paneId: string): ProjectLayout {
  if (layout.activePaneId === paneId) return layout;
  return panes(layout).some((pane) => pane.id === paneId)
    ? { ...layout, activePaneId: paneId }
    : layout;
}

export function focusRelativePane(layout: ProjectLayout, offset: -1 | 1): ProjectLayout {
  const ordered = panes(layout);
  const current = ordered.findIndex((pane) => pane.id === layout.activePaneId);
  const next = current < 0
    ? (offset > 0 ? 0 : ordered.length - 1)
    : (current + offset + ordered.length) % ordered.length;
  const activePaneId = ordered[next]?.id ?? layout.activePaneId;
  return activePaneId === layout.activePaneId ? layout : { ...layout, activePaneId };
}

export function assignSession(layout: ProjectLayout, paneId: string, sessionId: string | null): ProjectLayout {
  if (!panes(layout).some((pane) => pane.id === paneId)) return layout;
  return {
    root: mapPanes(layout.root, (pane) => {
      if (pane.id === paneId) return { ...pane, sessionId };
      return sessionId && pane.sessionId === sessionId ? { ...pane, sessionId: null } : pane;
    }),
    activePaneId: paneId,
  };
}

export function splitPane(
  layout: ProjectLayout,
  paneId: string,
  direction: SplitDirection,
  createId: IdFactory = defaultId,
  placement: SplitPlacement = "after",
): ProjectLayout | undefined {
  const existingPanes = panes(layout);
  if (existingPanes.length >= MAX_LAYOUT_PANES || !existingPanes.some((pane) => pane.id === paneId)) return undefined;
  const newPane = createPane(null, createId);
  const root = replacePane(layout.root, paneId, (pane) => ({
    type: "split",
    id: createId(),
    direction,
    ratio: 0.5,
    first: placement === "before" ? newPane : pane,
    second: placement === "before" ? pane : newPane,
  }));
  return root ? { root, activePaneId: newPane.id } : undefined;
}

export function closePane(layout: ProjectLayout, paneId: string): ProjectLayout {
  const ordered = panes(layout);
  if (!ordered.some((pane) => pane.id === paneId)) return layout;
  if (ordered.length === 1) return assignSession(layout, paneId, null);
  const root = removePane(layout.root, paneId);
  if (!root) return layout;
  const remaining = collectPanes(root);
  const fallback = remaining[0];
  if (!fallback) return layout;
  const activePaneId = layout.activePaneId === paneId
    ? remaining[Math.min(ordered.findIndex((pane) => pane.id === paneId), remaining.length - 1)]?.id ?? fallback.id
    : layout.activePaneId;
  return { root, activePaneId };
}

export function resizeSplit(layout: ProjectLayout, splitId: string, ratio: number): ProjectLayout {
  const bounded = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
  return { ...layout, root: mapNodes(layout.root, (node) => node.type === "split" && node.id === splitId ? { ...node, ratio: bounded } : node) };
}

export function decodeLayoutDocument(value: unknown): LayoutDocument | undefined {
  if (!isRecord(value) || value.version !== LAYOUT_VERSION || !isRecord(value.profiles)) return undefined;
  const profiles: Record<string, ProfileLayoutDocument> = {};
  for (const [profileId, candidate] of Object.entries(value.profiles)) {
    if (!validProfileId(profileId) || !isRecord(candidate) || !isRecord(candidate.projects)) return undefined;
    const projects = decodeProjects(candidate.projects);
    const sessionOrderByProject = decodeSessionOrder(candidate.sessionOrderByProject);
    const agentGroupsByProject = decodeAgentGroups(candidate.agentGroupsByProject);
    const detachedAgentRelationshipsByProject = decodeSessionOrder(candidate.detachedAgentRelationshipsByProject);
    if (!projects || !sessionOrderByProject || !agentGroupsByProject || !detachedAgentRelationshipsByProject) return undefined;
    profiles[profileId] = {
      projects,
      sessionOrderByProject,
      ...(Object.keys(agentGroupsByProject).length > 0 ? { agentGroupsByProject } : {}),
      ...(Object.keys(detachedAgentRelationshipsByProject).length > 0 ? { detachedAgentRelationshipsByProject } : {}),
    };
  }
  return { version: LAYOUT_VERSION, profiles };
}

export function migrateLegacyLayoutDocument(
  value: unknown,
  fallbackProfileId: string,
): LayoutDocument | undefined {
  if (!validProfileId(fallbackProfileId)
    || !isRecord(value)
    || value.version !== 1
    || !isRecord(value.projects)) return undefined;
  const projects = decodeProjects(value.projects);
  const sessionOrderByProject = decodeSessionOrder(value.sessionOrderByProject);
  if (!projects || !sessionOrderByProject) return undefined;
  const legacy: LegacyLayoutDocument = { version: 1, projects, sessionOrderByProject };
  const scopedProjects: Record<string, ProjectLayout> = {};
  const scopedOrder: Record<string, string[]> = {};
  for (const [projectId, layout] of Object.entries(legacy.projects)) {
    const projectIdentity = connectionEntityIdentity(projectId);
    const profileId = projectIdentity?.profileId ?? fallbackProfileId;
    const rawProjectId = projectIdentity?.entityId ?? projectId;
    const scopedProjectId = connectionEntityKey(profileId, rawProjectId);
    const scopedLayout = mapLayoutSessionIds(layout, (sessionId) => {
      const identity = connectionEntityIdentity(sessionId);
      if (identity && identity.profileId !== profileId) throw new Error("crossConnectionLayoutSession");
      return connectionEntityKey(profileId, identity?.entityId ?? sessionId);
    });
    scopedProjects[scopedProjectId] = scopedLayout;
    scopedOrder[scopedProjectId] = (legacy.sessionOrderByProject[projectId] ?? []).map((sessionId) => {
      const identity = connectionEntityIdentity(sessionId);
      if (identity && identity.profileId !== profileId) throw new Error("crossConnectionLayoutSession");
      return connectionEntityKey(profileId, identity?.entityId ?? sessionId);
    });
  }
  return layoutDocumentFromScoped(scopedProjects, scopedOrder);
}

export function flattenLayoutDocument(document: LayoutDocument): {
  projects: Record<string, ProjectLayout>;
  sessionOrderByProject: Record<string, string[]>;
  agentGroupsByProject: Record<string, AgentGroupLayout[]>;
  detachedAgentRelationshipsByProject: Record<string, string[]>;
} {
  const projects: Record<string, ProjectLayout> = {};
  const sessionOrderByProject: Record<string, string[]> = {};
  const agentGroupsByProject: Record<string, AgentGroupLayout[]> = {};
  const detachedAgentRelationshipsByProject: Record<string, string[]> = {};
  for (const [profileId, profile] of Object.entries(document.profiles)) {
    for (const [projectId, layout] of Object.entries(profile.projects)) {
      const scopedProjectId = connectionEntityKey(profileId, projectId);
      projects[scopedProjectId] = mapLayoutSessionIds(
        layout,
        (sessionId) => connectionEntityKey(profileId, sessionId),
      );
      sessionOrderByProject[scopedProjectId] = (profile.sessionOrderByProject[projectId] ?? [])
        .map((sessionId) => connectionEntityKey(profileId, sessionId));
      const groups = profile.agentGroupsByProject?.[projectId] ?? [];
      if (groups.length > 0) {
        agentGroupsByProject[scopedProjectId] = groups.map((group) => ({
          sessionIds: group.sessionIds.map((sessionId) => connectionEntityKey(profileId, sessionId)),
          ...(group.name ? { name: group.name } : {}),
        }));
      }
      const detachedRelationships = profile.detachedAgentRelationshipsByProject?.[projectId] ?? [];
      if (detachedRelationships.length > 0) {
        detachedAgentRelationshipsByProject[scopedProjectId] = detachedRelationships
          .map((sessionId) => connectionEntityKey(profileId, sessionId));
      }
    }
  }
  return { projects, sessionOrderByProject, agentGroupsByProject, detachedAgentRelationshipsByProject };
}

export function layoutDocumentFromScoped(
  projects: Readonly<Record<string, ProjectLayout>>,
  sessionOrderByProject: Readonly<Record<string, readonly string[]>>,
  agentGroupsByProject: Readonly<Record<string, readonly AgentGroupLayout[]>> = {},
  detachedAgentRelationshipsByProject: Readonly<Record<string, readonly string[]>> = {},
): LayoutDocument {
  const profiles: Record<string, ProfileLayoutDocument> = {};
  for (const [scopedProjectId, layout] of Object.entries(projects)) {
    const projectIdentity = connectionEntityIdentity(scopedProjectId)
      ?? { profileId: "local", entityId: scopedProjectId };
    const profile = profiles[projectIdentity.profileId] ??= { projects: {}, sessionOrderByProject: {} };
    profile.projects[projectIdentity.entityId] = mapLayoutSessionIds(layout, (sessionId) => {
      const identity = connectionEntityIdentity(sessionId)
        ?? { profileId: "local", entityId: sessionId };
      if (identity.profileId !== projectIdentity.profileId) throw new Error("crossConnectionLayoutSession");
      return identity.entityId;
    });
    profile.sessionOrderByProject[projectIdentity.entityId] = (
      sessionOrderByProject[scopedProjectId] ?? []
    ).map((sessionId) => {
      const identity = connectionEntityIdentity(sessionId)
        ?? { profileId: "local", entityId: sessionId };
      if (identity.profileId !== projectIdentity.profileId) throw new Error("crossConnectionLayoutSession");
      return identity.entityId;
    });
    const groups = agentGroupsByProject[scopedProjectId] ?? [];
    if (groups.length > 0) {
      const profileGroups = profile.agentGroupsByProject ??= {};
      profileGroups[projectIdentity.entityId] = groups.map((group) => ({
        sessionIds: group.sessionIds.map((sessionId) => {
          const identity = connectionEntityIdentity(sessionId)
            ?? { profileId: "local", entityId: sessionId };
          if (identity.profileId !== projectIdentity.profileId) throw new Error("crossConnectionLayoutSession");
          return identity.entityId;
        }),
        ...(group.name ? { name: group.name } : {}),
      }));
    }
    const detachedRelationships = detachedAgentRelationshipsByProject[scopedProjectId] ?? [];
    if (detachedRelationships.length > 0) {
      const profileRelationships = profile.detachedAgentRelationshipsByProject ??= {};
      profileRelationships[projectIdentity.entityId] = detachedRelationships.map((sessionId) => {
        const identity = connectionEntityIdentity(sessionId)
          ?? { profileId: "local", entityId: sessionId };
        if (identity.profileId !== projectIdentity.profileId) throw new Error("crossConnectionLayoutSession");
        return identity.entityId;
      });
    }
  }
  return { version: LAYOUT_VERSION, profiles };
}

function decodeProjects(value: Record<string, unknown>): Record<string, ProjectLayout> | undefined {
  const projects: Record<string, ProjectLayout> = {};
  for (const [projectId, candidate] of Object.entries(value)) {
    if (!validId(projectId)) return undefined;
    const layout = decodeProjectLayout(candidate);
    if (!layout) return undefined;
    projects[projectId] = layout;
  }
  return projects;
}

function decodeSessionOrder(value: unknown): Record<string, string[]> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const result: Record<string, string[]> = {};
  for (const [projectId, candidate] of Object.entries(value)) {
    if (!validId(projectId) || !Array.isArray(candidate) || candidate.length > 1_024) return undefined;
    if (!candidate.every(validId) || new Set(candidate).size !== candidate.length) return undefined;
    result[projectId] = candidate;
  }
  return result;
}

function decodeAgentGroups(value: unknown): Record<string, AgentGroupLayout[]> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const result: Record<string, AgentGroupLayout[]> = {};
  for (const [projectId, candidate] of Object.entries(value)) {
    if (!validId(projectId) || !Array.isArray(candidate) || candidate.length > 512) return undefined;
    const seenSessionIds = new Set<string>();
    const groups: AgentGroupLayout[] = [];
    for (const candidateGroup of candidate) {
      // The array form was written by the first grouping implementation. Keep
      // accepting it so an existing layout upgrades without losing groups.
      const legacy = Array.isArray(candidateGroup);
      const sessionIds = legacy
        ? candidateGroup
        : isRecord(candidateGroup) && Array.isArray(candidateGroup.sessionIds)
          ? candidateGroup.sessionIds
          : undefined;
      if (!sessionIds || sessionIds.length < 2 || sessionIds.length > 128 || !sessionIds.every(validId)) return undefined;
      if (new Set(sessionIds).size !== sessionIds.length || sessionIds.some((sessionId) => seenSessionIds.has(sessionId))) return undefined;
      const rawName = legacy ? undefined : candidateGroup.name;
      if (!(rawName === undefined || (typeof rawName === "string" && rawName.trim().length > 0 && rawName.trim().length <= 80))) return undefined;
      sessionIds.forEach((sessionId) => seenSessionIds.add(sessionId));
      groups.push({
        sessionIds: [...sessionIds],
        ...(typeof rawName === "string" ? { name: rawName.trim() } : {}),
      });
    }
    if (seenSessionIds.size > 1_024) return undefined;
    if (groups.length > 0) result[projectId] = groups;
  }
  return result;
}

function decodeProjectLayout(value: unknown): ProjectLayout | undefined {
  if (!isRecord(value) || !validId(value.activePaneId)) return undefined;
  const seenNodeIds = new Set<string>();
  const seenSessionIds = new Set<string>();
  const count = { panes: 0 };
  const root = decodeNode(value.root, 0, count, seenNodeIds, seenSessionIds);
  if (!root || count.panes > MAX_LAYOUT_PANES) return undefined;
  const layout = { root, activePaneId: value.activePaneId };
  return panes(layout).some((pane) => pane.id === value.activePaneId) ? layout : undefined;
}

function decodeNode(
  value: unknown,
  depth: number,
  count: { panes: number },
  nodeIds: Set<string>,
  sessionIds: Set<string>,
): LayoutNode | undefined {
  if (depth > MAX_LAYOUT_PANES || !isRecord(value) || !validId(value.id) || nodeIds.has(value.id)) return undefined;
  nodeIds.add(value.id);
  if (value.type === "pane") {
    if (!(value.sessionId === null || validId(value.sessionId))) return undefined;
    if (value.sessionId && sessionIds.has(value.sessionId)) return undefined;
    if (value.sessionId) sessionIds.add(value.sessionId);
    count.panes += 1;
    return { type: "pane", id: value.id, sessionId: value.sessionId };
  }
  if (value.type !== "split" || !(value.direction === "horizontal" || value.direction === "vertical")) return undefined;
  if (typeof value.ratio !== "number" || !Number.isFinite(value.ratio) || value.ratio < MIN_SPLIT_RATIO || value.ratio > MAX_SPLIT_RATIO) return undefined;
  const first = decodeNode(value.first, depth + 1, count, nodeIds, sessionIds);
  const second = decodeNode(value.second, depth + 1, count, nodeIds, sessionIds);
  return first && second
    ? { type: "split", id: value.id, direction: value.direction, ratio: value.ratio, first, second }
    : undefined;
}

function createPane(sessionId: string | null, createId: IdFactory): PaneNode {
  return { type: "pane", id: createId(), sessionId };
}

function collectPanes(node: LayoutNode): PaneNode[] {
  return node.type === "pane" ? [node] : [...collectPanes(node.first), ...collectPanes(node.second)];
}

function mapPanes(node: LayoutNode, transform: (pane: PaneNode) => PaneNode): LayoutNode {
  return node.type === "pane"
    ? transform(node)
    : { ...node, first: mapPanes(node.first, transform), second: mapPanes(node.second, transform) };
}

function mapNodes(node: LayoutNode, transform: (node: LayoutNode) => LayoutNode): LayoutNode {
  const mapped = node.type === "pane"
    ? node
    : { ...node, first: mapNodes(node.first, transform), second: mapNodes(node.second, transform) };
  return transform(mapped);
}

function replacePane(node: LayoutNode, paneId: string, replacement: (pane: PaneNode) => LayoutNode): LayoutNode | undefined {
  if (node.type === "pane") return node.id === paneId ? replacement(node) : node;
  const first = replacePane(node.first, paneId, replacement);
  const second = replacePane(node.second, paneId, replacement);
  return first && second ? { ...node, first, second } : undefined;
}

function removePane(node: LayoutNode, paneId: string): LayoutNode | undefined {
  if (node.type === "pane") return node.id === paneId ? undefined : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validProfileId(value: unknown): value is string {
  return value === "local"
    || (typeof value === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value));
}

function mapLayoutSessionIds(
  layout: ProjectLayout,
  transform: (sessionId: string) => string,
): ProjectLayout {
  return {
    ...layout,
    root: mapPanes(layout.root, (pane) => ({
      ...pane,
      sessionId: pane.sessionId ? transform(pane.sessionId) : null,
    })),
  };
}

function defaultId(): string {
  return globalThis.crypto.randomUUID();
}
