import { createStore } from "zustand/vanilla";
import {
  LAYOUT_VERSION,
  flattenLayoutDocument,
  layoutDocumentFromScoped,
  activePane,
  assignSession as assignSessionToPane,
  closePane as closeLayoutPane,
  createProjectLayout,
  focusPane as focusLayoutPane,
  focusRelativePane as focusRelativeLayoutPane,
  paneForSession as findPaneForSession,
  resizeSplit as resizeLayoutSplit,
  splitPane as splitLayoutPane,
  type LayoutDocument,
  type AgentGroupLayout,
  type ProjectLayout,
  type SplitPlacement,
  type SplitDirection,
} from "../../layout/model.js";
import type { AgentStatus } from "../model.js";
import { connectionEntityIdentity } from "../../connection-scope.js";

export type PresentationState = {
  selectedProjectId: string | undefined;
  selectedSessionByProject: Readonly<Record<string, string | null>>;
  sessionOrderByProject: Readonly<Record<string, readonly string[]>>;
  agentGroupsByProject: Readonly<Record<string, readonly AgentGroupLayout[]>>;
  detachedAgentRelationshipsByProject: Readonly<Record<string, readonly string[]>>;
  reviewReadySessionIds: ReadonlySet<string>;
  interruptedSessionObservations: ReadonlyMap<string, number>;
  acknowledgedInterruptedSessionObservations: ReadonlyMap<string, number>;
  layoutsByProject: Readonly<Record<string, ProjectLayout>>;
  layoutLoaded: boolean;
  layoutRevision: number;
  projectDialogOpen: boolean;
  hydrateLayouts(document: LayoutDocument): void;
  layoutDocument(): LayoutDocument;
  selectProject(projectId: string): void;
  selectSession(projectId: string, sessionId: string): void;
  updateReviewReadySessions(idleSessionIds: readonly string[], newlyReadySessionIds: readonly string[]): void;
  updateInterruptedSessions(statuses: readonly AgentStatus[]): void;
  navigateSession(projectId: string, sessionId: string): void;
  clearPane(projectId: string, paneId: string): void;
  openSessionInSplit(projectId: string, sessionId: string, direction: SplitDirection, placement?: SplitPlacement): boolean;
  openSessionInSplitAtPane(projectId: string, paneId: string, sessionId: string, direction: SplitDirection, placement?: SplitPlacement): boolean;
  splitActivePane(projectId: string, direction: SplitDirection): boolean;
  focusPane(projectId: string, paneId: string): void;
  focusRelativePane(projectId: string, offset: -1 | 1): void;
  resizeSplit(projectId: string, splitId: string, ratio: number): void;
  closePane(projectId: string, paneId: string): void;
  reorderSession(projectId: string, sessionId: string, targetSessionId: string, placement: "before" | "after"): boolean;
  groupAgentSessions(projectId: string, sessionId: string, targetSessionId: string): boolean;
  renameAgentGroup(projectId: string, sessionId: string, name: string): boolean;
  ungroupAgentGroup(projectId: string, sessionId: string): boolean;
  detachAgentRelationship(projectId: string, sessionId: string): boolean;
  ensureSelection(
    projectIds: readonly string[],
    sessionsByProject: ReadonlyMap<string, readonly string[]>,
    preserveProfileIds?: ReadonlySet<string>,
  ): void;
  openProjectDialog(): void;
  closeProjectDialog(): void;
};

export const presentationStore = createStore<PresentationState>((set, get) => ({
  selectedProjectId: undefined,
  selectedSessionByProject: {},
  sessionOrderByProject: {},
  agentGroupsByProject: {},
  detachedAgentRelationshipsByProject: {},
  reviewReadySessionIds: new Set(),
  interruptedSessionObservations: new Map(),
  acknowledgedInterruptedSessionObservations: new Map(),
  layoutsByProject: {},
  layoutLoaded: false,
  layoutRevision: 0,
  projectDialogOpen: false,
  hydrateLayouts: (document) => {
    const flattened = flattenLayoutDocument(document);
    set({
      layoutsByProject: flattened.projects,
      sessionOrderByProject: flattened.sessionOrderByProject,
      agentGroupsByProject: flattened.agentGroupsByProject,
      detachedAgentRelationshipsByProject: flattened.detachedAgentRelationshipsByProject,
      layoutLoaded: true,
      layoutRevision: 0,
    });
  },
  layoutDocument: () => layoutDocumentFromScoped(
    get().layoutsByProject,
    get().sessionOrderByProject,
    get().agentGroupsByProject,
    get().detachedAgentRelationshipsByProject,
  ),
  selectProject: (selectedProjectId) => set({ selectedProjectId }),
  selectSession: (projectId, sessionId) => {
    const current = get();
    const nextLayout = layoutForSession(current.layoutsByProject, projectId, sessionId);
    const layoutChanged = nextLayout !== current.layoutsByProject[projectId];
    const reviewReadySessionIds = new Set(current.reviewReadySessionIds);
    const acknowledgedInterruptedSessionObservations = new Map(current.acknowledgedInterruptedSessionObservations);
    const previousSessionId = current.selectedSessionByProject[projectId];
    const interruptedAt = previousSessionId && previousSessionId !== sessionId
      ? current.interruptedSessionObservations.get(previousSessionId)
      : undefined;
    if (previousSessionId && interruptedAt !== undefined) {
      acknowledgedInterruptedSessionObservations.set(previousSessionId, interruptedAt);
    }
    reviewReadySessionIds.delete(sessionId);
    set({
      selectedSessionByProject: { ...current.selectedSessionByProject, [projectId]: sessionId },
      reviewReadySessionIds,
      acknowledgedInterruptedSessionObservations,
      layoutsByProject: layoutChanged ? { ...current.layoutsByProject, [projectId]: nextLayout } : current.layoutsByProject,
      layoutRevision: layoutChanged ? current.layoutRevision + 1 : current.layoutRevision,
    });
  },
  updateReviewReadySessions: (idleSessionIds, newlyReadySessionIds) => {
    const idle = new Set(idleSessionIds);
    const reviewReadySessionIds = new Set([...get().reviewReadySessionIds].filter((sessionId) => idle.has(sessionId)));
    for (const sessionId of newlyReadySessionIds) reviewReadySessionIds.add(sessionId);
    set({ reviewReadySessionIds });
  },
  updateInterruptedSessions: (statuses) => {
    const interruptedSessionObservations = new Map(
      statuses
        .filter((status) => status.status === "interrupted")
        .map((status) => [status.sessionId, status.observedAtEpochMs] as const),
    );
    const acknowledgedInterruptedSessionObservations = new Map(
      [...get().acknowledgedInterruptedSessionObservations]
        .filter(([sessionId, observedAtEpochMs]) =>
          interruptedSessionObservations.get(sessionId) === observedAtEpochMs
        ),
    );
    set({ interruptedSessionObservations, acknowledgedInterruptedSessionObservations });
  },
  navigateSession: (projectId, sessionId) => get().selectSession(projectId, sessionId),
  clearPane: (projectId, paneId) => {
    const current = get();
    const layout = current.layoutsByProject[projectId];
    if (!layout) return;
    const nextLayout = assignSessionToPane(layout, paneId, null);
    set({
      layoutsByProject: { ...current.layoutsByProject, [projectId]: nextLayout },
      selectedSessionByProject: { ...current.selectedSessionByProject, [projectId]: activePane(nextLayout).sessionId },
      layoutRevision: current.layoutRevision + 1,
    });
  },
  openSessionInSplit: (projectId, sessionId, direction, placement = "after") => {
    const current = get();
    const layout = current.layoutsByProject[projectId] ?? createProjectLayout();
    return get().openSessionInSplitAtPane(projectId, layout.activePaneId, sessionId, direction, placement);
  },
  openSessionInSplitAtPane: (projectId, paneId, sessionId, direction, placement = "after") => {
    const current = get();
    const layout = current.layoutsByProject[projectId] ?? createProjectLayout();
    const existing = findPaneForSession(layout, sessionId);
    if (existing) {
      const nextLayout = focusLayoutPane(layout, existing.id);
      set({
        layoutsByProject: { ...current.layoutsByProject, [projectId]: nextLayout },
        selectedSessionByProject: { ...current.selectedSessionByProject, [projectId]: sessionId },
        layoutRevision: nextLayout === layout ? current.layoutRevision : current.layoutRevision + 1,
      });
      return true;
    }
    const splitLayout = splitLayoutPane(layout, paneId, direction, undefined, placement);
    if (!splitLayout) return false;
    const nextLayout = assignSessionToPane(splitLayout, splitLayout.activePaneId, sessionId);
    set({
      layoutsByProject: { ...current.layoutsByProject, [projectId]: nextLayout },
      selectedSessionByProject: { ...current.selectedSessionByProject, [projectId]: sessionId },
      layoutRevision: current.layoutRevision + 1,
    });
    return true;
  },
  splitActivePane: (projectId, direction) => {
    const current = get();
    const layout = current.layoutsByProject[projectId];
    if (!layout) return false;
    const nextLayout = splitLayoutPane(layout, layout.activePaneId, direction);
    if (!nextLayout) return false;
    set({
      layoutsByProject: { ...current.layoutsByProject, [projectId]: nextLayout },
      selectedSessionByProject: { ...current.selectedSessionByProject, [projectId]: null },
      layoutRevision: current.layoutRevision + 1,
    });
    return true;
  },
  focusPane: (projectId, paneId) => {
    const current = get();
    const layout = current.layoutsByProject[projectId];
    if (!layout) return;
    const nextLayout = focusLayoutPane(layout, paneId);
    if (nextLayout === layout) return;
    set({
      layoutsByProject: { ...current.layoutsByProject, [projectId]: nextLayout },
      selectedSessionByProject: { ...current.selectedSessionByProject, [projectId]: activePane(nextLayout).sessionId },
      layoutRevision: current.layoutRevision + 1,
    });
  },
  focusRelativePane: (projectId, offset) => {
    const current = get();
    const layout = current.layoutsByProject[projectId];
    if (!layout) return;
    const nextLayout = focusRelativeLayoutPane(layout, offset);
    if (nextLayout === layout) return;
    set({
      layoutsByProject: { ...current.layoutsByProject, [projectId]: nextLayout },
      selectedSessionByProject: { ...current.selectedSessionByProject, [projectId]: activePane(nextLayout).sessionId },
      layoutRevision: current.layoutRevision + 1,
    });
  },
  resizeSplit: (projectId, splitId, ratio) => {
    const current = get();
    const layout = current.layoutsByProject[projectId];
    if (!layout) return;
    set({
      layoutsByProject: { ...current.layoutsByProject, [projectId]: resizeLayoutSplit(layout, splitId, ratio) },
      layoutRevision: current.layoutRevision + 1,
    });
  },
  closePane: (projectId, paneId) => {
    const current = get();
    const layout = current.layoutsByProject[projectId];
    if (!layout) return;
    const nextLayout = closeLayoutPane(layout, paneId);
    set({
      layoutsByProject: { ...current.layoutsByProject, [projectId]: nextLayout },
      selectedSessionByProject: { ...current.selectedSessionByProject, [projectId]: activePane(nextLayout).sessionId },
      layoutRevision: current.layoutRevision + 1,
    });
  },
  reorderSession: (projectId, sessionId, targetSessionId, placement) => {
    if (sessionId === targetSessionId) return false;
    const current = get();
    const order = current.sessionOrderByProject[projectId] ?? [];
    if (!order.includes(sessionId) || !order.includes(targetSessionId)) return false;
    const groups = current.agentGroupsByProject[projectId] ?? [];
    // The center zone groups; either edge is deliberately an escape hatch.
    // Removing the source first keeps peer groups contiguous and makes a
    // two-Agent group reversible without a separate context-menu command.
    const nextGroups = removeSessionFromGroups(groups, sessionId);
    const destinationGroup = nextGroups.find((group) => group.sessionIds.includes(targetSessionId));
    const targetAnchor = destinationGroup
      ? (placement === "before" ? destinationGroup.sessionIds[0]! : destinationGroup.sessionIds.at(-1)!)
      : targetSessionId;
    let next = order.filter((value) => value !== sessionId);
    const targetIndex = next.indexOf(targetAnchor);
    next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, sessionId);
    next = groupedSessionOrder(next, nextGroups);
    if (arraysEqual(order, next) && agentGroupsEqual(groups, nextGroups)) return false;
    const agentGroupsByProject = { ...current.agentGroupsByProject };
    if (nextGroups.length > 0) agentGroupsByProject[projectId] = nextGroups;
    else delete agentGroupsByProject[projectId];
    set({
      sessionOrderByProject: { ...current.sessionOrderByProject, [projectId]: next },
      agentGroupsByProject,
      layoutRevision: current.layoutRevision + 1,
    });
    return true;
  },
  groupAgentSessions: (projectId, sessionId, targetSessionId) => {
    if (sessionId === targetSessionId) return false;
    const current = get();
    const order = current.sessionOrderByProject[projectId] ?? [];
    if (!order.includes(sessionId) || !order.includes(targetSessionId)) return false;
    const groups = current.agentGroupsByProject[projectId] ?? [];
    const sourceGroup = groups.find((group) => group.sessionIds.includes(sessionId));
    const targetGroup = groups.find((group) => group.sessionIds.includes(targetSessionId));
    if (sourceGroup && sourceGroup === targetGroup) return false;

    // Dropping any member of a peer group moves that whole group. Moving only
    // the grabbed row made two existing pairs look like an implicit two-Agent
    // cap: the grabbed Agent joined the destination while its former peers were
    // silently dissolved back into standalone rows.
    const movingSessionIds = sourceGroup ? [...sourceGroup.sessionIds] : [sessionId];
    const movingSet = new Set(movingSessionIds);
    const nextGroups = groups
      .filter((group) => group !== sourceGroup)
      .map((group) => ({
        ...group,
        sessionIds: group.sessionIds.filter((value) => !movingSet.has(value)),
      }))
      .filter((group) => group.sessionIds.length >= 2);
    const destination = nextGroups.find((group) => group.sessionIds.includes(targetSessionId));
    if (destination) {
      destination.sessionIds.splice(
        destination.sessionIds.indexOf(targetSessionId) + 1,
        0,
        ...movingSessionIds,
      );
    } else {
      nextGroups.push({
        sessionIds: [targetSessionId, ...movingSessionIds],
        ...(sourceGroup?.name === undefined ? {} : { name: sourceGroup.name }),
      });
    }
    const nextOrder = placeGroupAtTarget(order, nextGroups, movingSessionIds, targetSessionId);
    set({
      sessionOrderByProject: { ...current.sessionOrderByProject, [projectId]: nextOrder },
      agentGroupsByProject: { ...current.agentGroupsByProject, [projectId]: nextGroups },
      layoutRevision: current.layoutRevision + 1,
    });
    return true;
  },
  renameAgentGroup: (projectId, sessionId, name) => {
    const current = get();
    const groups = current.agentGroupsByProject[projectId] ?? [];
    const target = groups.find((group) => group.sessionIds.includes(sessionId));
    if (!target) return false;
    const normalizedName = normalizeAgentGroupName(name);
    if ((target.name ?? "") === normalizedName) return false;
    const nextGroups = groups.map((group) => group === target
      ? { sessionIds: [...group.sessionIds], ...(normalizedName ? { name: normalizedName } : {}) }
      : group);
    set({
      agentGroupsByProject: { ...current.agentGroupsByProject, [projectId]: nextGroups },
      layoutRevision: current.layoutRevision + 1,
    });
    return true;
  },
  ungroupAgentGroup: (projectId, sessionId) => {
    const current = get();
    const groups = current.agentGroupsByProject[projectId] ?? [];
    const nextGroups = groups.filter((group) => !group.sessionIds.includes(sessionId));
    if (nextGroups.length === groups.length) return false;
    const agentGroupsByProject = { ...current.agentGroupsByProject };
    if (nextGroups.length > 0) agentGroupsByProject[projectId] = nextGroups;
    else delete agentGroupsByProject[projectId];
    set({ agentGroupsByProject, layoutRevision: current.layoutRevision + 1 });
    return true;
  },
  detachAgentRelationship: (projectId, sessionId) => {
    const current = get();
    const detached = current.detachedAgentRelationshipsByProject[projectId] ?? [];
    if (detached.includes(sessionId)) return false;
    set({
      detachedAgentRelationshipsByProject: {
        ...current.detachedAgentRelationshipsByProject,
        [projectId]: [...detached, sessionId],
      },
      layoutRevision: current.layoutRevision + 1,
    });
    return true;
  },
  ensureSelection: (projectIds, sessionsByProject, preserveProfileIds = new Set()) => {
    const current = get();
    const selectedProjectId = current.selectedProjectId && projectIds.includes(current.selectedProjectId)
      ? current.selectedProjectId
      : projectIds[0];
    const selectedSessionByProject = { ...current.selectedSessionByProject };
    const sessionOrderByProject = { ...current.sessionOrderByProject };
    const agentGroupsByProject = { ...current.agentGroupsByProject };
    const detachedAgentRelationshipsByProject = { ...current.detachedAgentRelationshipsByProject };
    const layoutsByProject = { ...current.layoutsByProject };
    let layoutChanged = false;
    const projectIdsSet = new Set(projectIds);
    const preserveMissingProject = (projectId: string) => {
      const profileId = connectionEntityIdentity(projectId)?.profileId ?? "local";
      return preserveProfileIds.has(profileId);
    };
    for (const projectId of Object.keys(selectedSessionByProject)) {
      if (!projectIdsSet.has(projectId) && !preserveMissingProject(projectId)) {
        delete selectedSessionByProject[projectId];
      }
    }
    for (const projectId of Object.keys(sessionOrderByProject)) {
      if (!projectIdsSet.has(projectId) && !preserveMissingProject(projectId)) {
        delete sessionOrderByProject[projectId];
        layoutChanged = true;
      }
    }
    for (const projectId of Object.keys(agentGroupsByProject)) {
      if (!projectIdsSet.has(projectId) && !preserveMissingProject(projectId)) {
        delete agentGroupsByProject[projectId];
        layoutChanged = true;
      }
    }
    for (const projectId of Object.keys(detachedAgentRelationshipsByProject)) {
      if (!projectIdsSet.has(projectId) && !preserveMissingProject(projectId)) {
        delete detachedAgentRelationshipsByProject[projectId];
        layoutChanged = true;
      }
    }
    for (const projectId of Object.keys(layoutsByProject)) {
      if (!projectIdsSet.has(projectId) && !preserveMissingProject(projectId)) {
        delete layoutsByProject[projectId];
        layoutChanged = true;
      }
    }
    for (const projectId of projectIds) {
      const sessions = sessionsByProject.get(projectId) ?? [];
      const sessionIds = new Set(sessions);
      let layout = layoutsByProject[projectId];
      if (!layout) {
        layout = createProjectLayout(sessions[0] ?? null);
        layoutsByProject[projectId] = layout;
        layoutChanged = true;
      }
      const layoutSelection = activePane(layout).sessionId;
      selectedSessionByProject[projectId] = layoutSelection && sessionIds.has(layoutSelection) ? layoutSelection : null;
      const existingOrder = (sessionOrderByProject[projectId] ?? []).filter((value) => sessionIds.has(value));
      const orderedIds = new Set(existingOrder);
      const nextOrder = [...existingOrder, ...sessions.filter((value) => !orderedIds.has(value))];
      if (!arraysEqual(sessionOrderByProject[projectId] ?? [], nextOrder)) {
        sessionOrderByProject[projectId] = nextOrder;
        layoutChanged = true;
      }
      const existingGroups = agentGroupsByProject[projectId] ?? [];
      const nextGroups = existingGroups
        .map((group) => ({ ...group, sessionIds: group.sessionIds.filter((sessionId) => sessionIds.has(sessionId)) }))
        .filter((group) => group.sessionIds.length >= 2);
      if (!agentGroupsEqual(existingGroups, nextGroups)) {
        if (nextGroups.length > 0) agentGroupsByProject[projectId] = nextGroups;
        else delete agentGroupsByProject[projectId];
        layoutChanged = true;
      }
      const existingDetached = detachedAgentRelationshipsByProject[projectId] ?? [];
      const nextDetached = existingDetached.filter((sessionId) => sessionIds.has(sessionId));
      if (!arraysEqual(existingDetached, nextDetached)) {
        if (nextDetached.length > 0) detachedAgentRelationshipsByProject[projectId] = nextDetached;
        else delete detachedAgentRelationshipsByProject[projectId];
        layoutChanged = true;
      }
    }
    set({
      selectedProjectId,
      selectedSessionByProject,
      sessionOrderByProject,
      agentGroupsByProject,
      detachedAgentRelationshipsByProject,
      layoutsByProject,
      layoutRevision: layoutChanged ? current.layoutRevision + 1 : current.layoutRevision,
    });
  },
  openProjectDialog: () => set({ projectDialogOpen: true }),
  closeProjectDialog: () => set({ projectDialogOpen: false }),
}));

function layoutForSession(
  layouts: Readonly<Record<string, ProjectLayout>>,
  projectId: string,
  sessionId: string,
): ProjectLayout {
  const layout = layouts[projectId] ?? createProjectLayout(sessionId);
  const existing = findPaneForSession(layout, sessionId);
  return existing
    ? focusLayoutPane(layout, existing.id)
    : assignSessionToPane(layout, activePane(layout).id, sessionId);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function agentGroupsEqual(
  left: readonly AgentGroupLayout[],
  right: readonly AgentGroupLayout[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && value.name === candidate.name
      && arraysEqual(value.sessionIds, candidate.sessionIds);
  });
}

function removeSessionFromGroups(
  groups: readonly AgentGroupLayout[],
  sessionId: string,
): AgentGroupLayout[] {
  return groups
    .map((group) => ({ ...group, sessionIds: group.sessionIds.filter((value) => value !== sessionId) }))
    .filter((group) => group.sessionIds.length >= 2);
}

function groupedSessionOrder(
  order: readonly string[],
  groups: readonly AgentGroupLayout[],
): string[] {
  const groupBySessionId = new Map<string, AgentGroupLayout>();
  for (const group of groups) {
    for (const sessionId of group.sessionIds) groupBySessionId.set(sessionId, group);
  }
  const emitted = new Set<AgentGroupLayout>();
  return order.flatMap((sessionId) => {
    const group = groupBySessionId.get(sessionId);
    if (!group) return [sessionId];
    if (emitted.has(group)) return [];
    emitted.add(group);
    return group.sessionIds.filter((value) => order.includes(value));
  });
}

function placeGroupAtTarget(
  order: readonly string[],
  groups: readonly AgentGroupLayout[],
  sourceSessionIds: readonly string[],
  targetSessionId: string,
): string[] {
  const destination = groups.find((group) => group.sessionIds.includes(targetSessionId));
  if (!destination) return groupedSessionOrder(order, groups);
  const destinationIds = new Set(destination.sessionIds);
  const sourceIds = new Set(sourceSessionIds);
  const withoutSource = order.filter((sessionId) => !sourceIds.has(sessionId));
  const insertionIndex = withoutSource.findIndex((sessionId) => destinationIds.has(sessionId));
  const next = withoutSource.filter((sessionId) => !destinationIds.has(sessionId));
  next.splice(insertionIndex < 0 ? next.length : insertionIndex, 0, ...destination.sessionIds);
  return groupedSessionOrder(next, groups);
}

function normalizeAgentGroupName(name: string): string {
  return name.trim().slice(0, 80);
}
