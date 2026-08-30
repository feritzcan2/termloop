import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import { ConnectionBlocked } from "@/components/connection-blocked";
import { AgentAvatar } from "@/components/agent-avatar";
import { Banner, Card, CardDivider, EmptyState, SectionHeader, StatePill } from "@/components/primitives";
import { ProjectSelector } from "@/components/project-selector";
import { Row } from "@/components/row";
import { MockBadge, Screen, ScreenHeader } from "@/components/screen";
import { WorkspaceTabs, type WorkspaceTabId } from "@/components/workspace-tabs";
import { useConnections } from "@/features/connection/connection-store";
import { connectionRouteParams } from "@/features/connection/connection-route";
import { useOverview } from "@/features/overview/overview-store";
import {
  buildProjectOverview,
  buildProjectSummaries,
  type AgentRow,
} from "@/presentation/attention-overview";
import { connectionPresentation } from "@/presentation/connection-presentation";
import { relativeAge } from "@/presentation/relative-time";
import { color, geometry, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// Project workspace navigation follows desktop: Agents and Tasks are peer tabs.
/// Attention is carried by their tab markers and row order, so a waiting Agent is
/// never duplicated in a separate list just to make urgency visible.

export default function ProjectRoute() {
  const { projectId, connectionId } = useLocalSearchParams<{ projectId: string; connectionId?: string }>();
  const router = useRouter();
  const connections = useConnections();
  const store = useOverview();
  const [selectedTab, setSelectedTab] = useState<WorkspaceTabId>("agents");

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

  const needsYou = model?.needsYou ?? [];
  const agentRows = model?.agents ?? [];
  const taskAttentionCount = model?.tasks.filter((row) => asksForUser(row.tone)).length ?? 0;

  return (
    <Screen>
      <ScreenHeader
        back="Projects"
        center={<ProjectSelector current={current} />}
        right={
          <View style={styles.headerRight}>
            <Pressable
              onPress={store.refresh}
              accessibilityRole="button"
              accessibilityLabel="Refresh this project"
              hitSlop={12}
              style={styles.refresh}
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
            <View style={styles.workspaceActions}>
              <WorkspaceAction
                glyph="+"
                label="New Agent"
                primary
                disabled={model.project === undefined}
                onPress={() => router.push({
                  pathname: "/launch/[taskId]",
                  params: connectionRouteParams(connections.selectedId, {
                    taskId: `project:${model.project?.id ?? projectId}`,
                  }),
                })}
              />
              <WorkspaceAction
                glyph="✦"
                label="Steward"
                disabled={model.project === undefined || connections.selectedId === undefined}
                onPress={() => router.push({
                  pathname: "/steward/[projectId]",
                  params: { projectId, connectionId: connections.selectedId },
                })}
              />
            </View>
          </View>

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl refreshing={store.refreshing} onRefresh={store.refresh} tintColor={color.textSecondary} />
            }
          >
            {model.project === undefined ? (
              <Banner
                kind="warning"
                message="This project is no longer in the connected Mac's projection."
                action="Back"
                onAction={() => router.replace("/")}
              />
            ) : null}

            {selectedTab === "agents" ? (
              <>
                {needsYou.length > 0 ? (
                  <Banner
                    kind="warning"
                    message={`${needsYou.length} ${needsYou.length === 1 ? "agent needs" : "agents need"} your attention. They are pinned to the top.`}
                  />
                ) : null}
                <View style={styles.section}>
                  <SectionHeader label="Active agents" trailing={<Text style={styles.count}>{agentRows.length}</Text>} />
                  {agentRows.length === 0 ? (
                    <EmptyState
                      title="No active agents"
                      body="Start an Agent for this Project and its live Session will appear here."
                    />
                  ) : (
                    <Card>
                      {agentRows.map((row, index) => (
                        <View key={row.sessionId}>
                          {index === 0 ? null : <CardDivider />}
                          <AgentRowView row={row} nowMs={nowMs} />
                        </View>
                      ))}
                    </Card>
                  )}
                </View>

                {model.terminals.length > 0 ? (
                  <View style={styles.section}>
                    <SectionHeader label="Terminals" trailing={<Text style={styles.count}>{model.counts.terminals}</Text>} />
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
                          />
                        </View>
                      ))}
                    </Card>
                  </View>
                ) : null}
              </>
            ) : (
              <View style={styles.section}>
                <SectionHeader label="Open tasks" trailing={<Text style={styles.count}>{model.counts.tasks}</Text>} />
                {model.tasks.length === 0 ? (
                  <EmptyState
                    title="No open tasks"
                    body="Create a Task on your Mac and it will appear in this Project workspace."
                  />
                ) : (
                  <Card>
                    {model.tasks.map((row, index) => (
                      <View key={row.taskId}>
                        {index === 0 ? null : <CardDivider />}
                        <Row
                          tone={row.tone}
                          title={row.title}
                          detail={row.stateLine}
                          trailing={<StatePill tone={row.tone} label={row.attention?.label ?? row.stage.flag ?? "Ready"} />}
                          accessibleName={row.accessibleName}
                          minHeight={geometry.taskRowMinHeight}
                          onPress={() => router.push({
                            pathname: "/task/[taskId]",
                            params: connectionRouteParams(connections.selectedId, { taskId: row.taskId }),
                          })}
                        />
                      </View>
                    ))}
                  </Card>
                )}
              </View>
            )}
          </ScrollView>
        </>
      )}
    </Screen>
  );
}

function AgentRowView({ row, nowMs }: { row: AgentRow; nowMs: number }) {
  const router = useRouter();
  const connections = useConnections();
  const store = useOverview();
  const taskId = row.taskId;
  const detail = [row.taskTitle, row.relationship, row.runner ?? row.folder]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" · ");
  return (
    <View>
      <Row
        tone={row.tone}
        title={row.title}
        state={row.stateLabel}
        detail={detail.length > 0 ? detail : row.state.summary}
        meta={row.observedAtEpochMs === undefined ? undefined : relativeAge(row.observedAtEpochMs, nowMs)}
        accessibleName={row.accessibleName}
        trailing={<AgentAvatar agentId={row.agentId} active={row.attachable} />}
        disabled={!row.attachable}
        onPress={() => {
          store.dismissReview(row.sessionId);
          router.push({
            pathname: "/session/[sessionId]",
            params: connectionRouteParams(connections.selectedId, { sessionId: row.sessionId }),
          });
        }}
      />
      {taskId === undefined ? null : (
        <View style={styles.agentTaskActions}>
          <AgentTaskAction
            label="Task"
            accessibilityLabel={`Open Task ${row.taskTitle ?? taskId}`}
            onPress={() => router.push({
              pathname: "/task/[taskId]",
              params: connectionRouteParams(connections.selectedId, { taskId }),
            })}
          />
          <AgentTaskAction
            label="Changes"
            accessibilityLabel={`Open changes for Task ${row.taskTitle ?? taskId}`}
            onPress={() => router.push({
              pathname: "/task/[taskId]/changes",
              params: connectionRouteParams(connections.selectedId, { taskId }),
            })}
          />
        </View>
      )}
    </View>
  );
}

function AgentTaskAction({ label, accessibilityLabel, onPress }: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.agentTaskAction, pressed ? styles.agentTaskActionPressed : null]}
    >
      <Text style={styles.agentTaskActionLabel}>{label}</Text>
      <Text style={styles.agentTaskActionChevron}>›</Text>
    </Pressable>
  );
}

function WorkspaceAction({ glyph, label, primary = false, disabled = false, onPress }: {
  glyph: string;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.workspaceAction,
        primary ? styles.workspaceActionPrimary : null,
        pressed && !disabled ? styles.workspaceActionPressed : null,
        disabled ? styles.workspaceActionDisabled : null,
      ]}
    >
      <Text style={[styles.workspaceActionGlyph, primary ? styles.workspaceActionPrimaryText : null]}>{glyph}</Text>
      <Text style={[styles.workspaceActionLabel, primary ? styles.workspaceActionPrimaryText : null]}>{label}</Text>
    </Pressable>
  );
}

function asksForUser(tone: AgentRow["tone"]): boolean {
  return tone === "attention" || tone === "blocked" || tone === "review";
}

const styles = StyleSheet.create({
  headerRight: { flexDirection: "row", alignItems: "center", gap: 2 },
  refresh: { width: 34, height: geometry.touchTarget, alignItems: "center", justifyContent: "center" },
  refreshGlyph: { color: color.textSecondary, fontSize: 18 },
  loading: { flex: 1, justifyContent: "center", padding: space.screen },
  workspaceChrome: {
    gap: space.sm,
    paddingHorizontal: space.screen,
    paddingTop: space.sm,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.rule,
  },
  workspaceActions: { flexDirection: "row", gap: space.sm },
  workspaceAction: {
    flex: 1,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    borderRadius: 8,
    backgroundColor: color.bgRaised,
  },
  workspaceActionPrimary: {
    borderColor: `${color.accent}99`,
    backgroundColor: color.accentWash,
  },
  workspaceActionPressed: { backgroundColor: color.bgHover },
  workspaceActionDisabled: { opacity: 0.45 },
  workspaceActionGlyph: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 14, fontWeight: "800" },
  workspaceActionLabel: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 11.5, fontWeight: "700" },
  workspaceActionPrimaryText: { color: color.accentStrong },
  list: { flex: 1 },
  content: {
    gap: space.lg,
    paddingHorizontal: space.screen,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  section: { gap: space.sm },
  count: {
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  agentTaskActions: {
    flexDirection: "row",
    gap: space.sm,
    paddingLeft: 10,
    paddingRight: 10,
    paddingBottom: space.sm,
  },
  agentTaskAction: {
    flex: 1,
    minHeight: geometry.touchTarget,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    borderRadius: 8,
    backgroundColor: color.bgHover,
  },
  agentTaskActionPressed: { backgroundColor: color.borderStrong },
  agentTaskActionLabel: {
    color: color.accentStrong,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    fontWeight: "700",
  },
  agentTaskActionChevron: { color: color.textSecondary, fontSize: 16, lineHeight: 18 },
});
