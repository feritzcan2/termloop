import type { TaskDto } from "@termloop/contract/current";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  Banner,
  Card,
  CardDivider,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  StatePill,
  UnavailableNote,
} from "@/components/primitives";
import { TaskPipeline } from "@/components/task-pipeline";
import { useConnections } from "@/features/connection/connection-store";
import { connectionRouteParams } from "@/features/connection/connection-route";
import { launchBlockedReason } from "@/presentation/agent-launch-presentation";
import { AgentAvatar } from "@/components/agent-avatar";
import { ProjectSelector } from "@/components/project-selector";
import { Row } from "@/components/row";
import { MockBadge, Screen, ScreenHeader } from "@/components/screen";
import { useOverview } from "@/features/overview/overview-store";
import { buildProjectOverview, buildProjectSummaries } from "@/presentation/attention-overview";
import { basename, taskJiraIssueKey } from "@/presentation/dto-readers";
import { relativeAge } from "@/presentation/relative-time";
import {
  taskBranchNote,
  taskAtAGlance,
  taskChangeCount,
  taskChangeLabel,
  taskDivergenceNote,
  taskPresenceNote,
  taskRemoteActionNote,
  taskStage,
} from "@/presentation/task-presentation";
import type { RowTone } from "@/presentation/tone";
import { color, space } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

/// Task detail, read-only by design.
///
/// Every recovery a Task needs — creating a worktree, retrying, repairing, cleanup —
/// is a `core` command with fail-closed safety gates, and none of it belongs behind a
/// phone tap. So each degraded section states the fact and names the Mac as the place
/// to act, rather than offering a control the client would then have to refuse.
export default function TaskRoute() {
  const { taskId, connectionId } = useLocalSearchParams<{ taskId: string; connectionId?: string }>();
  const router = useRouter();
  const store = useOverview();
  const connections = useConnections();
  const selectingConnection = connectionId !== undefined && connections.selectedId !== connectionId;
  const selected = selectingConnection ? undefined : connections.selected;
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [tab, setTab] = useState<"overview" | "playbook">("overview");

  useEffect(() => {
    if (connectionId !== undefined && connections.selectedId !== connectionId) {
      connections.select(connectionId);
    }
  }, [connectionId, connections.select, connections.selectedId]);

  const task = store.overview?.tasks.find((candidate) => candidate.id === taskId);
  const summaries = useMemo(
    () => (store.overview ? buildProjectSummaries(store.overview, store.reviewReadySessionIds) : []),
    [store.overview, store.reviewReadySessionIds],
  );
  const current = summaries.find((summary) => summary.project.id === task?.project_id);
  const model = useMemo(
    () => (store.overview && task ? buildProjectOverview(store.overview, task.project_id, store.reviewReadySessionIds) : undefined),
    [store.overview, store.reviewReadySessionIds, task],
  );
  const nowMs = store.readAtEpochMs ?? 0;

  if (selectingConnection || store.load === "loading" || store.load === "idle") {
    return (
      <Screen>
        <ScreenHeader back="Project" title="Task" right={<MockBadge />} />
        <View style={styles.centre}><ActivityIndicator color={color.accentStrong} /></View>
      </Screen>
    );
  }

  if (!task) {
    return (
      <Screen>
        <ScreenHeader back="Project" title="Task" right={<MockBadge />} />
        <View style={styles.centre}>
          <Banner
            kind="warning"
            message="This task is no longer in the connected Mac's projection. It may have been deleted there."
            action="Back"
            onAction={() => router.back()}
          />
        </View>
      </Screen>
    );
  }

  const stage = taskStage(task);
  const remoteAction = taskRemoteActionNote(stage);
  const attached = attachedAgentRows(model?.agents ?? [], task);
  const changeCount = taskChangeCount(task);
  const glance = taskAtAGlance(stage, attached);

  return (
    <Screen>
      <ScreenHeader
        back="Project"
        center={<ProjectSelector current={current} />}
        right={<MockBadge />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{task.title}</Text>
          <View style={styles.pills}>
            <StatePill tone={task.status === "closed" ? "done" : "quiet"} label={task.status} />
          </View>
        </View>

        <View style={styles.tabs} accessibilityRole="tablist">
          <TaskTab label="Overview" selected={tab === "overview"} onPress={() => setTab("overview")} />
          <TaskTab label="Playbook" selected={tab === "playbook"} onPress={() => setTab("playbook")} />
        </View>

        {tab === "playbook" ? (
          <Section label="Playbook status">
            {selected === undefined ? (
              <UnavailableNote>No computer is selected.</UnavailableNote>
            ) : (
              <TaskPipeline
                connectionId={selected.id}
                projectId={task.project_id}
                taskId={task.id}
                nowEpochMs={nowMs}
                openSteward={() => router.push({
                  pathname: "/steward/[projectId]",
                  params: connectionRouteParams(selected?.id, { projectId: task.project_id }),
                })}
              />
            )}
          </Section>
        ) : (
          <>

        <Card>
          <View style={styles.glance}>
            <View style={styles.glanceHead}>
              <View style={[styles.glanceDot, { backgroundColor: statusColor(glance.tone) }]} />
              <Text style={styles.glanceLabel}>CURRENT STATUS</Text>
            </View>
            <Text style={styles.glanceTitle}>{glance.title}</Text>
            <Text style={styles.glanceDetail}>{glance.detail}</Text>
          </View>
        </Card>

        <View style={styles.actions}>
          <PrimaryButton
            label={attached.length > 0 ? "Start another agent" : "Start agent"}
            disabled={selected === undefined || launchBlockedReason(task) !== undefined}
            onPress={() => router.push({
              pathname: "/launch/[taskId]",
              params: connectionRouteParams(selected?.id, { taskId: task.id }),
            })}
          />
          {changeCount === undefined ? null : (
            <SecondaryButton
              label={taskChangeLabel(changeCount)}
              onPress={() => router.push({
                pathname: "/task/[taskId]/changes",
                params: connectionRouteParams(selected?.id, { taskId: task.id }),
              })}
            />
          )}
          <SecondaryButton
            label="Ask Steward"
            onPress={() => router.push({
              pathname: "/steward/[projectId]",
              params: connectionRouteParams(selected?.id, { projectId: task.project_id }),
            })}
          />
        </View>
        {launchBlockedReason(task) === undefined ? null : (
          <UnavailableNote>{launchBlockedReason(task)}</UnavailableNote>
        )}

        {attached.length === 0 ? null : (
          <Section label="Agents" trailing={<Text style={styles.count}>{attached.length}</Text>}>
            <Card>
              {attached.map((row, index) => (
                <View key={row.sessionId}>
                  {index === 0 ? null : <CardDivider />}
                  <Row
                    tone={row.tone}
                    title={row.title}
                    state={row.stateLabel}
                    detail={row.runner ?? row.state.summary}
                    meta={row.observedAtEpochMs === undefined ? undefined : relativeAge(row.observedAtEpochMs, nowMs)}
                    accessibleName={row.accessibleName}
                    trailing={<AgentAvatar agentId={row.agentId} active={row.attachable} />}
                    disabled={!row.attachable}
                    onPress={() => router.push({
                      pathname: "/session/[sessionId]",
                      params: connectionRouteParams(selected?.id, { sessionId: row.sessionId }),
                    })}
                  />
                </View>
              ))}
            </Card>
          </Section>
        )}

        <Section label="Goal">
          {task.brief === null || task.brief.length === 0 ? (
            <Text style={styles.emptyBody}>No description yet.</Text>
          ) : (
            <>
              <Text style={styles.body} numberOfLines={briefExpanded ? undefined : 3}>{task.brief}</Text>
              {task.brief.length > 140 ? (
                <Text
                  style={styles.more}
                  accessibilityRole="button"
                  onPress={() => setBriefExpanded((value) => !value)}
                >
                  {briefExpanded ? "less" : "more"}
                </Text>
              ) : null}
            </>
          )}
        </Section>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: detailsExpanded }}
          onPress={() => setDetailsExpanded((value) => !value)}
          style={({ pressed }) => [styles.detailsToggle, pressed && styles.detailsTogglePressed]}
        >
          <View>
            <Text style={styles.detailsTitle}>Technical details</Text>
            <Text style={styles.detailsSubtitle}>Progress, branch and workspace</Text>
          </View>
          <Text style={styles.detailsChevron}>{detailsExpanded ? "⌃" : "⌄"}</Text>
        </Pressable>

        {detailsExpanded ? (
          <View style={styles.detailsBody}>
            <Section label="Workspace">
              {task.branch === null ? null : (
                <>
                  <Text style={styles.mono}>{task.branch.name}</Text>
                  <Text style={styles.detail}>{taskBranchNote(task) ?? "Not observed yet."}</Text>
                  <Text style={styles.repo} numberOfLines={1}>{basename(task.branch.repository_root)}</Text>
                </>
              )}
              {task.worktree === null ? (
                <UnavailableNote>No workspace has been created for this task.</UnavailableNote>
              ) : (
                <>
                  <Text style={styles.mono} numberOfLines={1}>{task.worktree.path}</Text>
                  <Text style={styles.detail}>
                    {[taskPresenceNote(task), stage.summary].filter(Boolean).join(" · ")}
                  </Text>
                </>
              )}
              {taskDivergenceNote(task) === undefined ? null : (
                <View style={styles.inlineBanner}>
                  <Banner kind="warning" message={taskDivergenceNote(task) ?? ""} />
                </View>
              )}
              {remoteAction === undefined ? null : (
                <View style={styles.inlineBanner}>
                  <Banner kind={stage.tone === "blocked" ? "danger" : "info"} message={remoteAction} />
                </View>
              )}
            </Section>

            {task.jira_url === null ? null : (
              <Section label="Link">
                <Text
                  style={styles.link}
                  accessibilityRole="link"
                  accessibilityHint="Opens the issue in your browser"
                  onPress={() => { void Linking.openURL(task.jira_url ?? ""); }}
                >
                  {taskJiraIssueKey(task.jira_url)} ↗
                </Text>
              </Section>
            )}
          </View>
        ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function statusColor(tone: RowTone): string {
  switch (tone) {
    case "attention": return "#ff8e62";
    case "blocked": return color.danger;
    case "review": return color.agentCodex;
    case "working":
    case "done": return color.success;
    case "busy": return "#e8813f";
    case "interrupted": return color.warning;
    case "quiet": return color.textMuted;
  }
}

/// The Task's own attached sessions, taken from its presence projection and rendered
/// with the same rows the overview uses, so a Session cannot describe itself
/// differently on two screens.
function attachedAgentRows(
  agents: ReturnType<typeof buildProjectOverview>["agents"],
  task: TaskDto,
) {
  const attachedIds = new Set(
    (task.worktree_presence?.attached_sessions ?? []).map((entry) => entry.session_id),
  );
  return agents.filter((row) => attachedIds.has(row.sessionId));
}

function Section({ label, trailing, children }: {
  label: string;
  trailing?: ReactNode | undefined;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <SectionHeader label={label} trailing={trailing} />
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function TaskTab({ label, selected, onPress }: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tab,
        selected ? styles.tabSelected : null,
        pressed ? styles.tabPressed : null,
      ]}
    >
      <Text style={[styles.tabLabel, selected ? styles.tabLabelSelected : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, justifyContent: "center", padding: space.screen },
  content: { gap: space.lg, padding: space.screen, paddingBottom: space.xl },
  titleBlock: { gap: space.sm },
  /// A Task title is human prose, so it stays sans while the chrome around it
  /// speaks mono.
  title: { color: color.text, fontSize: 20, fontWeight: "700", lineHeight: 27 },
  pills: { flexDirection: "row", gap: 6 },
  tabs: {
    flexDirection: "row",
    padding: 3,
    borderRadius: 10,
    backgroundColor: color.bgRaised,
  },
  tab: {
    minHeight: 38,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  tabSelected: { backgroundColor: color.bgHover },
  tabPressed: { opacity: 0.75 },
  tabLabel: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "700" },
  tabLabelSelected: { color: color.accentStrong },
  glance: { gap: 7, padding: space.md },
  glanceHead: { flexDirection: "row", alignItems: "center", gap: 7 },
  glanceDot: { width: 8, height: 8, borderRadius: 4 },
  glanceLabel: {
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  glanceTitle: { color: color.text, fontSize: 17, fontWeight: "700" },
  glanceDetail: { color: color.textSecondary, fontSize: 13, lineHeight: 19 },
  section: { gap: 6 },
  sectionBody: { gap: 4 },
  body: { ...text.body, lineHeight: 19 },
  emptyBody: { color: color.textMuted, fontSize: 13 },
  more: { color: color.accentStrong, fontSize: 12, fontWeight: "700", paddingVertical: 4 },
  mono: { color: color.text, fontFamily: fontFamily.mono, fontSize: 13 },
  repo: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  detail: { color: color.textSecondary, fontSize: 12, lineHeight: 18 },
  count: {
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  inlineBanner: { marginTop: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
  detailsToggle: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: 10,
    backgroundColor: color.bgHover,
  },
  detailsTogglePressed: { borderColor: color.borderStrong },
  detailsTitle: { color: color.text, fontSize: 13, fontWeight: "700" },
  detailsSubtitle: { color: color.textMuted, fontSize: 11, marginTop: 2 },
  detailsChevron: { color: color.textSecondary, fontSize: 16 },
  detailsBody: { gap: space.lg },
  link: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 13, paddingVertical: 6 },
});
