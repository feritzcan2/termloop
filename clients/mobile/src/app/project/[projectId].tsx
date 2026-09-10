import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import { ConnectionBlocked } from "@/components/connection-blocked";
import { AgentAvatar } from "@/components/agent-avatar";
import { TaskAgentRow } from "@/features/tasks/task-agent-row";
import { Banner, Card, CardDivider, EmptyState } from "@/components/primitives";
import { ProjectSelector } from "@/components/project-selector";
import { Row } from "@/components/row";
import { MockBadge, Screen, ScreenHeader } from "@/components/screen";
import { WorkspaceTabs, type WorkspaceTabId } from "@/components/workspace-tabs";
import { TaskBrowser } from "@/features/tasks/task-browser";
import { SessionActionsSheet } from "@/features/session-actions/session-actions-sheet";
import { SwipeableSessionRow } from "@/features/session-actions/swipeable-session-row";
import { useConnections } from "@/features/connection/connection-store";
import { connectionRouteParams } from "@/features/connection/connection-route";
import { useOverview } from "@/features/overview/overview-store";
import { useMobileRuntime } from "@/composition/runtime-context";
import { WorkflowAgentGroupFrame, WorkflowAgentList } from "@/features/workflows/workflow-agent-list";
import { workflowAgentSegments, type WorkflowAgentMembership } from "@/presentation/workflow-agent-groups";
import {
  agentClusterMembers,
  buildProjectOverview,
  buildProjectSummaries,
  type AgentCluster,
  type AgentRow,
} from "@/presentation/attention-overview";
import { connectionPresentation } from "@/presentation/connection-presentation";
import { relativeAge } from "@/presentation/relative-time";
import { color, geometry, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// Project workspace navigation follows desktop: Agents and Tasks are peer tabs.
/// Attention is carried by their tab markers and row order, so a waiting Agent is
/// never duplicated in a banner or a separate list just to make urgency visible.
///
/// One screen, one primary action: an agent row opens its terminal, the floating
/// button starts a new Agent. Tasks have their own searchable list and explicit
/// links to agents and changes.

export default function ProjectRoute() {
  const { projectId, connectionId, tab } = useLocalSearchParams<{ projectId: string; connectionId?: string; tab?: string }>();
  const router = useRouter();
  const connections = useConnections();
  const store = useOverview();
  const runtime = useMobileRuntime();
  const [selectedTab, setSelectedTab] = useState<WorkspaceTabId>(tab === "tasks" ? "tasks" : "agents");
  const [terminalsOpen, setTerminalsOpen] = useState(false);
  const [actionSessionId, setActionSessionId] = useState<string>();

  useEffect(() => {
    if (connectionId !== undefined && connections.selectedId !== connectionId) {
      connections.select(connectionId);
    }
  }, [connectionId, connections.selectedId, connections.select]);

  const selectedBlock = connections.selected
    ? connectionPresentation(connections.selected.availability).block
    : undefined;

  const model = useMemo(
    () => (store.overview && projectId ? buildProjectOverview(store.overview, projectId, store.reviewReadySessionIds) : undefined),
    [store.overview, store.reviewReadySessionIds, projectId],
  );
  const summaries = useMemo(
    () => (store.overview ? buildProjectSummaries(store.overview, store.reviewReadySessionIds) : []),
    [store.overview, store.reviewReadySessionIds],
  );
  const current = summaries.find((summary) => summary.project.id === projectId);
  const nowMs = store.readAtEpochMs ?? 0;
  const actionSession = store.overview?.sessions.find((session) => session.id === actionSessionId);

  // A unified Home can switch connection and route in the same frame. Do not
  // briefly render the previous Mac's Project projection while selection catches up.
  if (connectionId !== undefined && connections.selectedId !== connectionId) {
    return (
      <Screen>
        <ScreenHeader back="Projects" title="Project" right={<MockBadge />} />
        <View style={styles.loading}>
          <ActivityIndicator color={color.accentStrong} />
        </View>
      </Screen>
    );
  }

  if (selectedBlock && connections.selected) {
    return (
      <Screen>
        <ScreenHeader back="Projects" title={connections.selected.name} right={<MockBadge />} />
        <ConnectionBlocked
          block={selectedBlock}
          connectionName={connections.selected.name}
          contractIdentity={connections.selected.contractIdentity}
          onRetry={selectedBlock === "offline" ? connections.refresh : undefined}
        />
      </Screen>
    );
  }

  const agentRows = model?.agents ?? [];
  const agentClusters = model?.agentClusters ?? [];
  const taskAttentionCount = model?.tasks.filter((row) => asksForUser(row.tone)).length ?? 0;
  const stewardReachable = model?.project !== undefined && connections.selectedId !== undefined;

  return (
    <Screen>
      <ScreenHeader
        back="Projects"
        center={<ProjectSelector current={current} />}
        right={
          <View style={styles.headerRight}>
            <Pressable
              onPress={() => router.push({
                pathname: "/steward/[projectId]",
                params: { projectId, connectionId: connections.selectedId },
              })}
              disabled={!stewardReachable}
              accessibilityRole="button"
              accessibilityState={{ disabled: !stewardReachable }}
              accessibilityLabel="Open Steward"
              hitSlop={12}
              style={[styles.headerAction, stewardReachable ? null : styles.headerActionDisabled]}
            >
              <Text style={styles.stewardGlyph}>✦</Text>
            </Pressable>
            <Pressable
              onPress={store.refresh}
              accessibilityRole="button"
              accessibilityLabel="Refresh this project"
              hitSlop={12}
              style={styles.headerAction}
            >
              <Text style={styles.refreshGlyph}>⟳</Text>
            </Pressable>
            <MockBadge />
          </View>
        }
      />

      {model === undefined ? (
        <View style={styles.loading}>
          {store.load === "failed"
            ? <Banner kind="danger" message={store.error ?? "This project could not be read."} action="Retry" onAction={store.refresh} />
            : <ActivityIndicator color={color.accentStrong} />}
        </View>
      ) : (
        <>
          <View style={styles.workspaceChrome}>
            <WorkspaceTabs
              selected={selectedTab}
              agents={{ count: model.counts.agents, attentionCount: model.counts.needsYou }}
              tasks={{ count: model.counts.tasks, attentionCount: taskAttentionCount }}
              select={setSelectedTab}
            />
          </View>

          {model.project === undefined ? (
            <Banner
              kind="warning"
              message="This project is no longer in the connected Mac's projection."
              action="Back"
              onAction={() => router.replace("/")}
            />
          ) : null}

          {store.error === undefined ? null : (
            <Banner kind="warning" message="Showing the last known project state." action="Retry" onAction={store.refresh} />
          )}
          {selectedTab === "tasks" ? (
            <TaskBrowser
              key={`${connections.selectedId}:${projectId}`}
              rows={model.tasks}
              tasks={store.overview?.tasks ?? []}
              agents={model.agents}
              refreshing={store.refreshing}
              refresh={store.refresh}
              openTask={(taskId) => router.push({ pathname: "/task/[taskId]", params: connectionRouteParams(connections.selectedId, { taskId }) })}
              openChanges={(taskId) => router.push({ pathname: "/task/[taskId]/changes", params: connectionRouteParams(connections.selectedId, { taskId }) })}
              openAgent={(sessionId) => {
                store.dismissReview(sessionId);
                router.push({ pathname: "/session/[sessionId]", params: connectionRouteParams(connections.selectedId, { sessionId }) });
              }}
              openTemplates={() => router.push({ pathname: "/workflows/[projectId]", params: connectionRouteParams(connections.selectedId, { projectId }) })}
              openSteward={() => router.push({ pathname: "/steward/[projectId]", params: connectionRouteParams(connections.selectedId, { projectId }) })}
            />
          ) : (
            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.content}
              refreshControl={
                <RefreshControl refreshing={store.refreshing} onRefresh={store.refresh} tintColor={color.textSecondary} />
              }
            >
              <View style={styles.section}>
                {agentRows.length === 0 ? (
                  <EmptyState
                    title="No agents"
                    body="Start an Agent for this Project and its Session will appear here."
                  />
                ) : (
                  <WorkflowAgentList
                    key={`${connections.selectedId}:${projectId}`}
                    connectionId={connections.selectedId ?? ""}
                    projectId={projectId}
                    online={connections.selected?.availability === "online"}
                    agentDataStale={store.error !== undefined}
                    templates={runtime.workflowTemplates}
                    control={runtime.control}
                    sessions={store.overview?.sessions ?? []}
                    tasks={store.overview?.tasks ?? []}
                    clusters={agentClusters}
                    renderCluster={(cluster, memberships, stale) => <AgentClusterView cluster={cluster} memberships={memberships} workflowDataStale={stale} nowMs={nowMs} openActions={setActionSessionId} />}
                  />
                )}
              </View>

              {model.terminals.length > 0 ? (
                <View style={styles.section}>
                  {/*
                    Terminals fold. They are ambient context next to the agents the
                    screen exists for, and an always-open second list makes the first
                    one end sooner than it has to.
                  */}
                  <Pressable
                    onPress={() => setTerminalsOpen((open) => !open)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: terminalsOpen }}
                    accessibilityLabel={`Terminals, ${model.counts.terminals}`}
                    style={({ pressed }) => [styles.terminalsToggle, pressed ? styles.terminalsTogglePressed : null]}
                  >
                    <Text style={styles.terminalsChevron}>{terminalsOpen ? "▾" : "▸"}</Text>
                    <Text style={styles.terminalsLabel}>Terminals</Text>
                    <Text style={styles.count}>{model.counts.terminals}</Text>
                  </Pressable>
                  {terminalsOpen ? (
                    <Card>
                      {model.terminals.map((row, index) => (
                        <View key={row.sessionId}>
                          {index === 0 ? null : <CardDivider />}
                          <Row
                            tone="quiet"
                            title={row.title}
                            detail={row.detail}
                            accessibleName={row.accessibleName}
                            disabled={!row.attachable}
                            onPress={() => router.push({
                              pathname: "/session/[sessionId]",
                              params: connectionRouteParams(connections.selectedId, { sessionId: row.sessionId }),
                            })}
                            onLongPress={() => setActionSessionId(row.sessionId)}
                          />
                        </View>
                      ))}
                    </Card>
                  ) : null}
                </View>
              ) : null}
            </ScrollView>
          )}

          {model.project === undefined || selectedTab !== "agents" ? null : (
            <Pressable
              onPress={() => router.push({
                pathname: "/launch/[taskId]",
                params: connectionRouteParams(connections.selectedId, {
                  taskId: `project:${projectId}`,
                }),
              })}
              accessibilityRole="button"
              accessibilityLabel="New Agent"
              style={({ pressed }) => [styles.fab, pressed ? styles.fabPressed : null]}
            >
              <Text style={styles.fabGlyph}>+</Text>
            </Pressable>
          )}
        </>
      )}
      <SessionActionsSheet
        session={actionSession}
        visible={actionSession !== undefined}
        onClose={() => setActionSessionId(undefined)}
        onOpenSession={(sessionId) => router.push({
          pathname: "/session/[sessionId]",
          params: connectionRouteParams(connections.selectedId, { sessionId }),
        })}
        onOpenTask={(taskId) => router.push({
          pathname: "/task/[taskId]",
          params: connectionRouteParams(connections.selectedId, { taskId }),
        })}
        onOpenChanges={(taskId) => router.push({
          pathname: "/task/[taskId]/changes",
          params: connectionRouteParams(connections.selectedId, { taskId }),
        })}
      />
    </Screen>
  );
}

function AgentClusterView({ cluster, memberships, workflowDataStale, nowMs, openActions }: {
  cluster: AgentCluster;
  memberships: ReadonlyMap<string, WorkflowAgentMembership>;
  workflowDataStale: boolean;
  nowMs: number;
  openActions(sessionId: string): void;
}) {
  const sourceIds = new Set(cluster.groups.map(({ source }) => source.sessionId));
  const rows = workflowAgentSegments(agentClusterMembers(cluster), memberships).map((segment, segmentIndex) => {
    const members = segment.rows.map((row, index) => {
      const content = <AgentRowView row={row} membership={memberships.get(row.sessionId)} nowMs={nowMs} openActions={openActions} />;
      return segment.group || sourceIds.has(row.sessionId)
        ? <View key={row.sessionId}>{index === 0 ? null : <CardDivider />}{content}</View>
        : <View key={row.sessionId} style={styles.helperWrap}>
          <View style={styles.helperConnector} />
          <View style={styles.helperBody}><CardDivider />{content}</View>
        </View>;
    });
    return <View key={segment.rows[0]!.sessionId}>
      {segmentIndex === 0 ? null : <CardDivider />}
      {segment.group
        ? <WorkflowAgentGroupFrame group={segment.group} stale={workflowDataStale}>{members}</WorkflowAgentGroupFrame>
        : members}
    </View>;
  });
  if (cluster.manualGroup === undefined) return <>{rows}</>;
  const count = agentClusterMembers(cluster).length;
  const name = cluster.manualGroup.name;
  return (
    <View style={styles.manualGroup}>
      <View pointerEvents="none" style={styles.manualGroupAccent} />
      <View
        style={styles.manualGroupHeader}
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${name ? `${name}, ` : ""}Agent group with ${count} agents`}
      >
        <View style={styles.manualGroupIdentity}>
          <Text style={styles.manualGroupKind}>AGENT GROUP</Text>
          {name === undefined ? null : (
            <Text style={styles.manualGroupName} numberOfLines={1}>{name}</Text>
          )}
        </View>
        <View style={styles.manualGroupCountBadge}>
          <Text style={styles.manualGroupCount}>{count}</Text>
        </View>
      </View>
      <CardDivider />
      {rows}
    </View>
  );
}

function AgentRowView({ row, membership, nowMs, openActions }: { row: AgentRow; membership?: WorkflowAgentMembership | undefined; nowMs: number; openActions(sessionId: string): void }) {
  const router = useRouter();
  const connections = useConnections();
  const store = useOverview();
  const session = store.overview?.sessions.find((candidate) => candidate.id === row.sessionId);
  const taskId = row.taskId ?? membership?.group.taskId;
  const task = store.overview?.tasks.find((candidate) => candidate.id === taskId);
  const title = membership?.displayName ?? row.title;
  const age = row.observedAtEpochMs === undefined ? undefined : relativeAge(row.observedAtEpochMs, nowMs);
  const onPress = () => {
    if (!row.attachable) {
      openActions(row.sessionId);
      return;
    }
    store.dismissReview(row.sessionId);
    router.push({
      pathname: "/session/[sessionId]",
      params: connectionRouteParams(connections.selectedId, { sessionId: row.sessionId }),
    });
  };
  const onLongPress = () => openActions(row.sessionId);
  const content = task && !membership
    ? <TaskAgentRow row={row} task={task} age={age} onPress={onPress} onLongPress={onLongPress} />
    : <Row
      tone={row.tone}
      title={title}
      state={row.stateLabel}
      detail={row.runner ?? row.folder}
      meta={age}
      accessibleName={membership ? `${membership.displayName}, Workflow ${membership.group.name}, ${row.accessibleName}` : row.accessibleName}
      trailing={<AgentAvatar agentId={row.agentId} active={row.attachable} />}
      onPress={onPress}
      onLongPress={onLongPress}
    />;
  return session === undefined
    ? content
    : <SwipeableSessionRow session={session}>{content}</SwipeableSessionRow>;
}

function asksForUser(tone: AgentRow["tone"]): boolean {
  return tone === "attention" || tone === "blocked" || tone === "review";
}

const styles = StyleSheet.create({
  headerRight: { flexDirection: "row", alignItems: "center", gap: 2 },
  headerAction: { width: 34, height: geometry.touchTarget, alignItems: "center", justifyContent: "center" },
  headerActionDisabled: { opacity: 0.4 },
  stewardGlyph: { color: color.accentStrong, fontSize: 15 },
  refreshGlyph: { color: color.textSecondary, fontSize: 18 },
  loading: { flex: 1, justifyContent: "center", padding: space.screen },
  workspaceChrome: {
    paddingHorizontal: space.screen,
    paddingTop: space.sm,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.rule,
  },
  list: { flex: 1 },
  content: {
    gap: space.lg,
    paddingHorizontal: space.screen,
    paddingTop: space.md,
    /// Room for the floating button, so the last row is never trapped underneath it.
    paddingBottom: space.xl + 64,
  },
  section: { gap: space.sm },
  manualGroup: {
    position: "relative",
    marginHorizontal: 6,
    marginVertical: 7,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: `${color.accent}99`,
    borderRadius: 11,
    backgroundColor: color.bgSidebar,
    shadowColor: color.accent,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  manualGroupAccent: {
    position: "absolute",
    zIndex: 1,
    top: 0,
    bottom: 0,
    left: 0,
    width: 3,
    backgroundColor: color.accent,
  },
  manualGroupHeader: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingLeft: 13,
    paddingRight: 10,
    backgroundColor: color.accentWash,
  },
  manualGroupIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  manualGroupKind: {
    color: color.accentStrong,
    fontFamily: fontFamily.mono,
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 1,
  },
  manualGroupName: {
    flex: 1,
    color: color.text,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  manualGroupCountBadge: {
    minWidth: 24,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: color.accent,
  },
  manualGroupCount: {
    color: color.onAccent,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    fontWeight: "900",
    fontVariant: ["tabular-nums"],
  },
  helperWrap: {
    position: "relative",
    paddingLeft: 18,
  },
  helperConnector: {
    position: "absolute",
    top: 0,
    left: 7,
    width: 11,
    height: 29,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: `${color.accent}66`,
    borderBottomLeftRadius: 6,
  },
  helperBody: { overflow: "hidden" },
  count: {
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  terminalsToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: geometry.touchTarget,
    paddingHorizontal: 2,
  },
  terminalsTogglePressed: { opacity: 0.7 },
  terminalsChevron: { color: color.textMuted, fontSize: 11, width: 12 },
  terminalsLabel: {
    flex: 1,
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  fab: {
    position: "absolute",
    right: space.screen,
    bottom: space.screen,
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 26,
    borderWidth: 1,
    borderColor: `${color.accent}99`,
    backgroundColor: color.accent,
    shadowColor: color.shadow,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabPressed: { opacity: 0.85 },
  fabGlyph: { color: color.onAccent, fontSize: 26, lineHeight: 30, fontWeight: "600" },
});
