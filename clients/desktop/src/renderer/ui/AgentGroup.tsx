import { useDroppable } from "@dnd-kit/core";
import { Fragment, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { AgentGroupLayout } from "../../layout/model.js";
import type { Session } from "../model.js";
import { askToSessionGroups, type AskToSessionGroup } from "./SessionRow.js";
import { useOptionalSidebarSessionDnd } from "./SidebarSessionDnd.js";

export type AgentSessionCluster = {
  key: string;
  groups: readonly AskToSessionGroup[];
  manuallyGrouped: boolean;
  manualGroup?: AgentGroupLayout | undefined;
};

export function agentSessionClusterMembers(cluster: AgentSessionCluster): Session[] {
  return cluster.groups.flatMap(({ source, helpers }) => [source, ...helpers]);
}

/// Manual groups join peer Agent roots only. Ask-To/fork helpers remain nested
/// solely under the exact source projected by Core, then that intact hierarchy
/// can sit beside another peer hierarchy inside the user's visual group.
export function agentSessionClusters(
  sessions: readonly Session[],
  manualGroups: readonly AgentGroupLayout[] = [],
  detachedRelationshipSessionIds: ReadonlySet<string> = new Set(),
): AgentSessionCluster[] {
  const relationshipGroups = askToSessionGroups(sessions, detachedRelationshipSessionIds);
  const relationshipByRootId = new Map(relationshipGroups.map((group) => [group.source.id, group]));
  const rootIdBySessionId = new Map<string, string>();
  for (const group of relationshipGroups) {
    rootIdBySessionId.set(group.source.id, group.source.id);
    for (const helper of group.helpers) rootIdBySessionId.set(helper.id, group.source.id);
  }

  const claimedRootIds = new Set<string>();
  const normalizedGroups: { layout: AgentGroupLayout; rootIds: string[] }[] = [];
  for (const group of manualGroups) {
    const rootIds: string[] = [];
    for (const sessionId of group.sessionIds) {
      const rootId = rootIdBySessionId.get(sessionId);
      if (!rootId || rootIds.includes(rootId) || claimedRootIds.has(rootId)) continue;
      if (relationshipByRootId.get(rootId)?.source.kind === "Agent") rootIds.push(rootId);
    }
    if (rootIds.length < 2) continue;
    rootIds.forEach((rootId) => claimedRootIds.add(rootId));
    normalizedGroups.push({ layout: group, rootIds });
  }
  const manualGroupByRootId = new Map<string, { layout: AgentGroupLayout; rootIds: readonly string[] }>();
  for (const group of normalizedGroups) {
    for (const rootId of group.rootIds) manualGroupByRootId.set(rootId, group);
  }

  const emitted = new Set<AgentGroupLayout>();
  const clusters: AgentSessionCluster[] = [];
  for (const relationship of relationshipGroups) {
    const manualGroup = manualGroupByRootId.get(relationship.source.id);
    if (!manualGroup) {
      clusters.push({ key: relationship.source.id, groups: [relationship], manuallyGrouped: false });
      continue;
    }
    if (emitted.has(manualGroup.layout)) continue;
    emitted.add(manualGroup.layout);
    clusters.push({
      key: `manual:${manualGroup.rootIds.join("|")}`,
      groups: manualGroup.rootIds.flatMap((rootId) => {
        const group = relationshipByRootId.get(rootId);
        return group ? [group] : [];
      }),
      manuallyGrouped: true,
      manualGroup: manualGroup.layout,
    });
  }
  return clusters;
}

export function AgentGroupFrame({ cluster, compact = false, renameGroup, ungroup, children }: {
  cluster: AgentSessionCluster;
  compact?: boolean;
  renameGroup?: ((sessionId: string, name: string) => void) | undefined;
  ungroup?: ((sessionId: string) => void) | undefined;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cluster.manualGroup?.name ?? "");
  const locatorSessionId = cluster.groups[0]?.source.id;
  const sidebarDnd = useOptionalSidebarSessionDnd();
  const groupDrop = useDroppable({
    id: `${compact ? "task" : "active"}-agent-group-target:${locatorSessionId ?? cluster.key}`,
    data: { kind: "agentGroup", sessionId: locatorSessionId },
    disabled: !cluster.manuallyGrouped
      || !locatorSessionId
      || !sidebarDnd
      || Boolean(sidebarDnd.draggedSession && cluster.manualGroup?.sessionIds.includes(sidebarDnd.draggedSession.id)),
  });
  useEffect(() => {
    if (!editing) setDraft(cluster.manualGroup?.name ?? "");
  }, [cluster.manualGroup?.name, editing]);
  if (!cluster.manuallyGrouped) return <Fragment>{children}</Fragment>;
  const count = agentSessionClusterMembers(cluster).length;
  const groupDropActive = sidebarDnd?.sessionDropTarget?.surface === "group"
    && cluster.manualGroup?.sessionIds.includes(sidebarDnd.sessionDropTarget.sessionId);
  const visibleName = cluster.manualGroup?.name ?? "GROUP";
  const commitName = () => {
    if (locatorSessionId) renameGroup?.(locatorSessionId, draft);
    setEditing(false);
  };
  const nameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitName();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(cluster.manualGroup?.name ?? "");
      setEditing(false);
    }
  };
  return (
    <div
      className={`manual-agent-group${compact ? " compact" : ""}${groupDropActive ? " drop-on" : ""}`}
      role="group"
      aria-label={`${cluster.manualGroup?.name ? `${cluster.manualGroup.name}, ` : ""}Agent group with ${count} agents`}
      data-agent-group="manual"
      data-agent-group-size={count}
    >
      <div
        ref={groupDrop.setNodeRef}
        className="manual-agent-group-label"
        data-agent-group-drop-target={locatorSessionId}
      >
        <button
          className="manual-agent-group-remove"
          type="button"
          title="Ungroup agents"
          aria-label={`Ungroup ${cluster.manualGroup?.name ?? "agent group"}`}
          disabled={!locatorSessionId || !ungroup}
          onClick={() => { if (locatorSessionId) ungroup?.(locatorSessionId); }}
        >×</button>
        {editing ? <input
          className="manual-agent-group-name-input"
          aria-label="Group name"
          value={draft}
          maxLength={80}
          autoFocus
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commitName}
          onKeyDown={nameKeyDown}
        /> : <button
          className="manual-agent-group-name"
          type="button"
          title="Rename group"
          disabled={!locatorSessionId || !renameGroup}
          onClick={() => setEditing(true)}
        >{visibleName}</button>}
        <b aria-hidden="true">{count}</b>
      </div>
      {children}
    </div>
  );
}
