import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

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
import { SessionActionsSheet } from "@/features/session-actions/session-actions-sheet";
import { SwipeableSessionRow } from "@/features/session-actions/swipeable-session-row";
import { launchBlockedReason } from "@/presentation/agent-launch-presentation";
import { AgentAvatar } from "@/components/agent-avatar";
import { ProjectSelector } from "@/components/project-selector";
import { Row } from "@/components/row";
import { MockBadge, Screen, ScreenHeader } from "@/components/screen";
import { useOverview } from "@/features/overview/overview-store";
import { useMobileRuntime } from "@/composition/runtime-context";
import { TaskWorkflowLauncher } from "@/features/workflows/task-workflow-launcher";
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
import { taskAttachedAgents } from "@/presentation/task-browser";
import type { RowTone } from "@/presentation/tone";
import { color, geometry, space, toneColor } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

/// Task detail keeps Task/worktree recovery read-only while attached Session rows
/// expose the same bounded lifecycle and Agent-coordination menu as Project rows.
export default function TaskRoute() {
  const { taskId, connectionId } = useLocalSearchParams<{ taskId: string; connectionId?: string }>();
  const router = useRouter();
  const store = useOverview();
  const connections = useConnections();
  const runtime = useMobileRuntime();
  const selectingConnection = connectionId !== undefined && connections.selectedId !== connectionId;
  const selected = selectingConnection ? undefined : connections.selected;
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [tab, setTab] = useState<"overview" | "workflow" | "playbook">("overview");
  const [actionSessionId, setActionSessionId] = useState<string>();
  const scroll = useRef<ScrollView>(null);

  useEffect(() => { scroll.current?.scrollTo({ y: 0, animated: false }); }, [tab, taskId]);

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
  const actionSession = store.overview?.sessions.find((session) => session.id === actionSessionId);

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
  const attached = taskAttachedAgents(task, model?.agents ?? []);
  const changeCount = taskChangeCount(task);
  const glance = taskAtAGlance(stage, attached);
  const primaryAgent = attached.find((agent) => agent.attachable);
  const launchBlock = selected?.availability !== "online" ? "Reconnect to your Mac to start an agent." : launchBlockedReason(task);
  const openAgent = (sessionId: string) => {
    store.dismissReview(sessionId);
    router.push({ pathname: "/session/[sessionId]", params: connectionRouteParams(selected?.id, { sessionId }) });
  };

  return (
    <Screen>
      <ScreenHeader
        back="Tasks"
        backFallback={{ pathname: "/project/[projectId]", params: connectionRouteParams(selected?.id, { projectId: task.project_id, tab: "tasks" }) }}
        center={<ProjectSelector current={current} />}
        right={<MockBadge />}
      />
      <View style={styles.detailHeader}>
        <View style={styles.titleBlock}>
          <View style={styles.pills}>
            <Text style={styles.taskEyebrow}>TASK</Text>
            <StatePill tone={task.status === "closed" ? "done" : "quiet"} label={task.status} />
            {task.jira_url === null ? null : (
              <Pressable accessibilityRole="link" accessibilityLabel={`Open ${taskJiraIssueKey(task.jira_url)}`} onPress={() => { void Linking.openURL(task.jira_url!); }} style={styles.issueLink}>
                <Text style={styles.link}>{taskJiraIssueKey(task.jira_url)} ↗</Text>
              </Pressable>
            )}
          </View>
          <Text style={styles.title} numberOfLines={3} accessibilityRole="header">{task.title}</Text>
        </View>

        <View style={styles.tabs} accessibilityRole="tablist">
          <TaskTab label="Overview" selected={tab === "overview"} onPress={() => setTab("overview")} />
          <TaskTab label="Workflow" selected={tab === "workflow"} onPress={() => setTab("workflow")} />
          <TaskTab label="Playbook" selected={tab === "playbook"} onPress={() => setTab("playbook")} />
        </View>
      </View>
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        refreshControl={<RefreshControl refreshing={store.refreshing} onRefresh={store.refresh} tintColor={color.textSecondary} />}
      >
        {store.error === undefined ? null : <Banner kind="warning" message="Showing the last known task state. Pull to refresh." action="Retry" onAction={store.refresh} />}
        {selected?.availability === "online" ? null : <Banner kind="warning" message="Your Mac is disconnected. The last known task state is shown." />}
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
        ) : null}
        {tab === "overview" ? (
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
                label={primaryAgent ? (primaryAgent.tone === "attention" ? "Reply to agent" : primaryAgent.tone === "review" ? "Review agent" : "Open agent") : "Start agent"}
                disabled={primaryAgent === undefined && launchBlock !== undefined}
                onPress={() => {
                  if (primaryAgent) openAgent(primaryAgent.sessionId);
                  else if (launchBlock === undefined) router.push({
                    pathname: "/launch/[taskId]",
                    params: connectionRouteParams(selected?.id, { taskId: task.id }),
                  });
                }}
              />
              <View style={styles.secondaryActions}>
                {changeCount === undefined ? null : (
                  <SecondaryButton
                    label={`Review ${taskChangeLabel(changeCount)}`}
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
            </View>
            {launchBlock === undefined || primaryAgent ? null : (
              <UnavailableNote>{launchBlock}</UnavailableNote>
            )}

            {attached.length === 0 ? null : (
              <Section label="Agents" trailing={<Text style={styles.count}>{attached.length}</Text>}>
                <Card>
                  {attached.map((row, index) => {
                    const session = store.overview?.sessions.find((candidate) => candidate.id === row.sessionId);
                    const content = (
                      <Row
                        tone={row.tone}
                        title={row.title}
                        state={row.stateLabel}
                        detail={row.runner ?? row.state.summary}
                        meta={row.observedAtEpochMs === undefined ? undefined : relativeAge(row.observedAtEpochMs, nowMs)}
                        accessibleName={row.accessibleName}
                        trailing={<AgentAvatar agentId={row.agentId} active={row.attachable} />}
                        onPress={() => {
                          if (!row.attachable) {
                            setActionSessionId(row.sessionId);
                            return;
                          }
                          openAgent(row.sessionId);
                        }}
                        onLongPress={() => setActionSessionId(row.sessionId)}
                      />
                    );
                    return (
                      <View key={row.sessionId}>
                        {index === 0 ? null : <CardDivider />}
                        {session === undefined
                          ? content
                          : <SwipeableSessionRow session={session}>{content}</SwipeableSessionRow>}
                      </View>
                    );
                  })}
                </Card>
              </Section>
            )}
            {attached.length > 0 && launchBlock === undefined ? (
              <SecondaryButton label="Start another agent" onPress={() => router.push({ pathname: "/launch/[taskId]", params: connectionRouteParams(selected?.id, { taskId: task.id }) })} />
            ) : null}

            <Section label="Goal">
              <Text style={styles.goalTitle}>{task.title}</Text>
              {task.brief === null || task.brief.length === 0 ? (
                <Text style={styles.emptyBody}>No description yet.</Text>
              ) : (
                <>
                  <Text style={styles.body} numberOfLines={briefExpanded || task.brief.length <= 140 ? undefined : 3}>{task.brief}</Text>
                  {task.brief.length > 140 ? (
                    <Pressable style={styles.moreButton} accessibilityRole="button" accessibilityState={{ expanded: briefExpanded }} onPress={() => setBriefExpanded((value) => !value)}>
                      <Text style={styles.more}>{briefExpanded ? "Show less" : "Read full goal"}</Text>
                    </Pressable>
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

              </View>
            ) : null}
          </>
        ) : null}
        {/* Keep the launcher mounted so tab changes retain edited goals and pending launch guards. */}
        <View style={tab === "workflow" ? undefined : styles.hiddenPanel} accessibilityElementsHidden={tab !== "workflow"} importantForAccessibility={tab === "workflow" ? "auto" : "no-hide-descendants"}>
          {selected ? <TaskWorkflowLauncher
            key={`${selected.id}:${task.id}`}
            task={task}
            connectionId={selected.id}
            online={selected.availability === "online"}
            templates={runtime.workflowTemplates}
            launch={runtime.workflowLaunch}
            control={runtime.control}
            sessions={store.overview?.sessions ?? []}
            statuses={store.overview?.agentStatuses ?? []}
            agentDataStale={store.error !== undefined || store.load !== "ready"}
            openTemplates={() => router.push({ pathname: "/workflows/[projectId]", params: connectionRouteParams(selected.id, { projectId: task.project_id }) })}
            openSession={(sessionId) => {
              void store.refresh();
              router.push({ pathname: "/session/[sessionId]", params: connectionRouteParams(selected.id, { sessionId, projectId: task.project_id, workflowTaskId: task.id }) });
            }}
          /> : null}

        </View>
      </ScrollView>
      <SessionActionsSheet
        session={actionSession}
        visible={actionSession !== undefined}
        onClose={() => setActionSessionId(undefined)}
        onOpenSession={(sessionId) => router.push({
          pathname: "/session/[sessionId]",
          params: connectionRouteParams(selected?.id, { sessionId }),
        })}
        onOpenTask={(targetTaskId) => {
          if (targetTaskId === task.id) {
            setActionSessionId(undefined);
            return;
          }
          router.push({
            pathname: "/task/[taskId]",
            params: connectionRouteParams(selected?.id, { taskId: targetTaskId }),
          });
        }}
        onOpenChanges={(targetTaskId) => router.push({
          pathname: "/task/[taskId]/changes",
          params: connectionRouteParams(selected?.id, { taskId: targetTaskId }),
        })}
      />
    </Screen>
  );
}

function statusColor(tone: RowTone): string {
  switch (tone) {
    case "attention": return toneColor.attention;
    case "blocked": return color.danger;
    case "review": return color.agentCodex;
    case "working":
    case "done": return color.success;
    case "busy": return toneColor.busy;
    case "interrupted": return color.warning;
    case "quiet": return color.textMuted;
  }
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
  content: { gap: space.lg, padding: space.screen, paddingBottom: space.xl + 64 },
  detailHeader: { padding: space.screen, gap: space.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.rule },
  taskEyebrow: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  issueLink: { marginLeft: "auto", minHeight: geometry.touchTarget, justifyContent: "center" },
  hiddenPanel: { display: "none" },
  titleBlock: { gap: space.sm },
  /// A Task title is human prose, so it stays sans while the chrome around it
  /// speaks mono.
  title: { color: color.text, fontSize: 20, fontWeight: "700", lineHeight: 27 },
  pills: { flexDirection: "row", alignItems: "center", gap: 8 },
  tabs: {
    flexDirection: "row",
    padding: 3,
    borderRadius: 10,
    backgroundColor: color.bgRaised,
  },
  tab: {
    minHeight: geometry.touchTarget,
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
  goalTitle: { color: color.text, fontSize: 15, fontWeight: "600", lineHeight: 21, marginBottom: 4 },
  moreButton: { minHeight: geometry.touchTarget, justifyContent: "center", alignSelf: "flex-start" },
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
  actions: { gap: space.xs },
  secondaryActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
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
