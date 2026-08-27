import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import { ConnectionBlocked } from "@/components/connection-blocked";
import { AgentAvatar } from "@/components/agent-avatar";
import { Banner, Card, CardDivider, Chip, EmptyState, PrimaryButton, SectionHeader } from "@/components/primitives";
import { ProjectSelector } from "@/components/project-selector";
import { Row } from "@/components/row";
import { MockBadge, Screen, ScreenHeader } from "@/components/screen";
import { useConnections } from "@/features/connection/connection-store";
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

/// The Project's attention overview: one ordered scroll, not tabs and not a board.
///
/// Section order is fixed — Needs you, Agents, Tasks, Terminals — so the answer to
/// "does anything want me" is always in the same place. `Needs you` renders only when
/// it has rows: an empty box under that heading is a question the screen keeps asking
/// and never answering.
type Filter = "all" | "needsYou" | "agents" | "tasks";

export default function ProjectRoute() {
  const { projectId, connectionId } = useLocalSearchParams<{ projectId: string; connectionId?: string }>();
  const router = useRouter();
  const connections = useConnections();
  const store = useOverview();
  const [filter, setFilter] = useState<Filter>("all");

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

  const showAgents = filter === "all" || filter === "agents";
  const showTasks = filter === "all" || filter === "tasks";
  const showTerminals = filter === "all";
  const needsYou = model?.needsYou ?? [];
  /// The "Needs you" filter narrows to the same computed list the section renders, so
  /// the chip count and the rows can never come from two different derivations.
  const agentRows = filter === "needsYou" ? needsYou : (model?.agents ?? []);

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
          {/*
            The filter row is a measured box, not a bare flex child. As a sibling of the
            list below it, flexbox split the screen between the two and stretched every
            chip into a full-height capsule.
          */}
          <View style={styles.filterBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filters}
            >
              <Chip label="All" selected={filter === "all"} onPress={() => setFilter("all")} />
              <Chip label="Needs you" count={countOrNone(model.counts.needsYou)} selected={filter === "needsYou"} onPress={() => setFilter("needsYou")} />
              <Chip label="Agents" count={countOrNone(model.counts.agents)} selected={filter === "agents"} onPress={() => setFilter("agents")} />
              <Chip label="Tasks" count={countOrNone(model.counts.tasks)} selected={filter === "tasks"} onPress={() => setFilter("tasks")} />
            </ScrollView>
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

            {showAgents && needsYou.length > 0 ? (
              <View style={styles.section}>
                <SectionHeader label="Needs you" />
                <Card>
                  {needsYou.map((row, index) => (
                    <View key={row.sessionId}>
                      {index === 0 ? null : <CardDivider />}
                      <AgentRowView row={row} nowMs={nowMs} />
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            {showAgents || filter === "needsYou" ? (
              <View style={styles.section}>
                {filter === "needsYou" ? (
                  <SectionHeader label="Needs you" trailing={<Text style={styles.count}>{agentRows.length}</Text>} />
                ) : (
                  <>
                    <PrimaryButton
                      label="+ New agent"
                      disabled={model.project === undefined}
                      onPress={() => router.push({
                        pathname: "/launch/[taskId]",
                        params: { taskId: `project:${model.project?.id ?? projectId}` },
                      })}
                    />
                    <SectionHeader label="Agents" trailing={<Text style={styles.count}>{agentRows.length}</Text>} />
                  </>
                )}
                {agentRows.length === 0 ? (
                  <Text style={styles.quiet}>
                    {filter === "needsYou"
                      ? "Nothing needs you right now."
                      : "No agent sessions in this project."}
                  </Text>
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
            ) : null}

            {showTasks ? (
              <View style={styles.section}>
                <SectionHeader label="Tasks" trailing={<Text style={styles.count}>{model.counts.tasks}</Text>} />
                {model.tasks.length === 0 ? (
                  <Text style={styles.quiet}>No open tasks in this project.</Text>
                ) : (
                  <Card>
                    {model.tasks.map((row, index) => (
                      <View key={row.taskId}>
                        {index === 0 ? null : <CardDivider />}
                        <Row
                          tone={row.tone}
                          title={row.title}
                          detail={row.stateLine}
                          accessibleName={row.accessibleName}
                          minHeight={geometry.taskRowMinHeight}
                          onPress={() => router.push({
                            pathname: "/task/[taskId]",
                            params: { taskId: row.taskId },
                          })}
                        />
                      </View>
                    ))}
                  </Card>
                )}
              </View>
            ) : null}

            {showTerminals && model.terminals.length > 0 ? (
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
                          params: { sessionId: row.sessionId },
                        })}
                      />
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            {model.counts.agents === 0 && model.counts.tasks === 0 && model.counts.terminals === 0 ? (
              <EmptyState
                title="Nothing here yet"
                body="Create a task or start a session on your Mac, and it shows up in this project."
              />
            ) : null}
          </ScrollView>
        </>
      )}
    </Screen>
  );
}

function AgentRowView({ row, nowMs }: { row: AgentRow; nowMs: number }) {
  const router = useRouter();
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
            params: { sessionId: row.sessionId },
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
              params: { taskId },
            })}
          />
          <AgentTaskAction
            label="Changes"
            accessibilityLabel={`Open changes for Task ${row.taskTitle ?? taskId}`}
            onPress={() => router.push({
              pathname: "/task/[taskId]/changes",
              params: { taskId },
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

/// A zero count on a filter chip is noise: the chip already says what it filters, and
/// selecting it explains the emptiness in a sentence.
function countOrNone(value: number): number | undefined {
  return value > 0 ? value : undefined;
}

const styles = StyleSheet.create({
  headerRight: { flexDirection: "row", alignItems: "center", gap: 2 },
  refresh: { width: 34, height: geometry.touchTarget, alignItems: "center", justifyContent: "center" },
  refreshGlyph: { color: color.textSecondary, fontSize: 18 },
  loading: { flex: 1, justifyContent: "center", padding: space.screen },
  filterBar: { height: geometry.filterBar },
  filters: {
    alignItems: "center",
    gap: 7,
    paddingHorizontal: space.screen,
  },
  list: { flex: 1 },
  content: {
    gap: 20,
    paddingHorizontal: space.screen,
    paddingTop: space.xs,
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
  quiet: { color: color.textMuted, fontSize: 12.5, lineHeight: 18, paddingVertical: 2 },
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
