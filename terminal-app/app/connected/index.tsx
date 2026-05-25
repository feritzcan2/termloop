import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { saveLastTerminal } from "../../lib/last-terminal";
import {
  closeSession,
  getActiveClient,
  getActiveConnectionId,
} from "../../lib/session";
import { relativeTime } from "../../lib/format";
import {
  pickTerminalSurface,
  projectSummaryPath,
  surfaceLabel,
  waitForTerminalSurface,
  workspaceLabel,
  workspaceProjectId,
  type JiraTicketSummary,
  type ProjectSummary,
  type TerminalAgentSummary,
  type WorkspaceRunTargetSummary,
  type WorkspaceSummary,
} from "../../lib/termloop-client";
import { colors, monoFont, radii } from "../../lib/theme";
import { TasksView } from "../../components/tasks-view";

type ProjectState = ProjectSummary | null | "loading";
type WorkspaceSectionKind = "worktree" | "workspace";
type AgentTargetKind = WorkspaceSectionKind | "new_worktree";
type WorkspaceViewMode = "active" | "worktrees" | "tasks";


interface WorkspaceRow {
  ws: WorkspaceSummary;
  title: string;
  sectionKind: WorkspaceSectionKind;
  worktreeKey: string | null;
  worktreeLabel: string | null;
  worktreePath: string | null;
  toolLabel: string | null;
  statusLabel: string | null;
  activityLabel: string | null;
  changeLabel: string | null;
}

interface WorkspaceSection {
  key: string;
  kind: WorkspaceSectionKind;
  title: string;
  subtitle: string;
  data: WorkspaceRow[];
}

interface AgentTarget {
  key: string;
  kind: AgentTargetKind;
  label: string;
  detail: string;
  cwd?: string;
  projectId?: string;
}

interface WorkspaceContextState {
  loading: boolean;
  jira: JiraTicketSummary | null;
  runTargets: WorkspaceRunTargetSummary[];
}

interface WorkspaceContextSummary {
  loading: boolean;
  jira: JiraTicketSummary | null;
  runTargets: WorkspaceRunTargetSummary[];
}

export default function ConnectedScreen() {
  const router = useRouter();
  const { notifWorkspaceId } = useLocalSearchParams<{ notifWorkspaceId?: string }>();
  const handledNotifRef = useRef<string | null>(null);
  const client = getActiveClient();
  const [current, setCurrent] = useState<ProjectState>("loading");
  const seededProjectRef = useRef(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agents, setAgents] = useState<TerminalAgentSummary[] | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState("project");
  const [worktreeBranchName, setWorktreeBranchName] = useState("");
  const [allowDirtyWorktree, setAllowDirtyWorktree] = useState(false);
  const [startingAgent, setStartingAgent] = useState(false);
  const [workspaceContexts, setWorkspaceContexts] = useState<
    Record<string, WorkspaceContextState>
  >({});
  const [contextRefreshKey, setContextRefreshKey] = useState(0);
  const [selectedView, setSelectedView] = useState<WorkspaceViewMode>("active");

  const loadOverview = useCallback(async () => {
    if (!client) return;
    setRefreshing(true);
    setLoadError(null);
    try {
      if (!seededProjectRef.current) {
        const [cur, ws] = await Promise.all([
          client.currentProject(),
          client.listWorkspaces(),
        ]);
        setCurrent(cur);
        setWorkspaces(ws);
        seededProjectRef.current = true;
      } else {
        const ws = await client.listWorkspaces();
        setWorkspaces(ws);
      }
      setContextRefreshKey((value) => value + 1);
    } catch (err) {
      const message = String((err as Error).message ?? err);
      setLoadError(message);
      Alert.alert("Failed to load", message);
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    if (!client) {
      router.replace("/");
      return;
    }
    loadOverview();
  }, [client, loadOverview, router]);

  const onDisconnect = async () => {
    await closeSession();
    router.replace("/");
  };

  const openProjectPicker = async () => {
    if (!client) return;
    setPickerOpen(true);
    if (projects === null) {
      try {
        const list = await client.listProjects();
        setProjects(list);
      } catch (err) {
        Alert.alert(
          "Failed to load projects",
          String((err as Error).message ?? err)
        );
        setProjects([]);
      }
    }
  };

  const onPickProject = (p: ProjectSummary) => {
    if (current !== "loading" && current?.id === p.id) {
      setPickerOpen(false);
      return;
    }
    setCurrent(p);
    setPickerOpen(false);
    setContextRefreshKey((value) => value + 1);
  };

  const onOpenWorkspace = useCallback(async (ws: WorkspaceSummary) => {
    if (!client) return;
    setOpeningId(ws.id);
    try {
      const surfaces = await client.listSurfaces(ws.id);
      const surface = pickTerminalSurface(surfaces);
      if (!surface) {
        Alert.alert(
          "No terminal surface",
          surfaces.length === 0
            ? `Workspace "${workspaceLabel(ws)}" has no surfaces yet.`
            : `Workspace "${workspaceLabel(ws)}" has no terminal surface to open.`
        );
        return;
      }
      const wsName = workspaceLabel(ws);
      const surfaceName = surfaceLabel(surface);
      const connectionId = getActiveConnectionId();
      if (connectionId) {
        await saveLastTerminal({
          connectionId,
          workspaceId: ws.id,
          surfaceId: surface.id,
          workspaceName: wsName,
          surfaceName,
        }).catch(() => {});
      }
      const projectName = current !== "loading" ? current?.name ?? "" : "";
      const projectPath =
        current !== "loading" ? projectSummaryPath(current) ?? "" : "";
      router.push({
        pathname: "/connected/terminal",
        params: {
          workspaceId: ws.id,
          surfaceId: surface.id,
          name: wsName,
          surfaceName,
          projectName,
          projectPath,
        },
      });
    } catch (err) {
      Alert.alert("Failed to open", String((err as Error).message ?? err));
    } finally {
      setOpeningId(null);
    }
  }, [client, current, router]);

  useEffect(() => {
    if (!notifWorkspaceId || !workspaces || handledNotifRef.current === notifWorkspaceId) return;
    const ws = workspaces.find((w) => w.id === notifWorkspaceId);
    if (!ws) return;
    handledNotifRef.current = notifWorkspaceId;
    onOpenWorkspace(ws);
  }, [notifWorkspaceId, workspaces, onOpenWorkspace]);

  const projectFilterId =
    current === "loading" || current === null ? null : current.id;

  const visibleWorkspaces = useMemo<WorkspaceSummary[] | null>(() => {
    if (workspaces === null) return null;
    if (!projectFilterId) return workspaces;
    return workspaces.filter(
      (ws) => workspaceProjectId(ws) === projectFilterId
    );
  }, [workspaces, projectFilterId]);

  const visibleWorkspaceKey = useMemo(() => {
    return visibleWorkspaces?.map((ws) => ws.id).join("|") ?? "";
  }, [visibleWorkspaces]);

  useEffect(() => {
    if (!client || visibleWorkspaces === null) return;
    const candidates = visibleWorkspaces.filter(workspaceCanHaveBindings);
    if (candidates.length === 0) {
      setWorkspaceContexts({});
      return;
    }

    let cancelled = false;
    setWorkspaceContexts((currentMap) => {
      const next: Record<string, WorkspaceContextState> = {};
      for (const ws of candidates) {
        const previous = currentMap[ws.id];
        next[ws.id] = {
          loading: true,
          jira: previous?.jira ?? null,
          runTargets: previous?.runTargets ?? [],
        };
      }
      return next;
    });

    for (const ws of candidates) {
      Promise.all([client.getJiraTicket(ws.id), client.getRunTargets(ws.id)])
        .then(([jira, runTargets]) => {
          if (cancelled) return;
          setWorkspaceContexts((currentMap) => ({
            ...currentMap,
            [ws.id]: { loading: false, jira, runTargets },
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setWorkspaceContexts((currentMap) => ({
            ...currentMap,
            [ws.id]: {
              loading: false,
              jira: currentMap[ws.id]?.jira ?? null,
              runTargets: currentMap[ws.id]?.runTargets ?? [],
            },
          }));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [client, visibleWorkspaces, visibleWorkspaceKey, contextRefreshKey]);

  const sections = useMemo<WorkspaceSection[]>(() => {
    if (visibleWorkspaces === null) return [];
    const worktreeSections = new Map<string, WorkspaceSection>();
    const workspaceRows: WorkspaceRow[] = [];

    for (const ws of visibleWorkspaces) {
      const row = buildWorkspaceRow(ws);
      if (row.worktreeKey) {
        const existing = worktreeSections.get(row.worktreeKey);
        if (existing) {
          existing.data.push(row);
        } else {
          worktreeSections.set(row.worktreeKey, {
            key: row.worktreeKey,
            kind: "worktree",
            title: row.worktreeLabel ?? "Worktree",
            subtitle: "",
            data: [row],
          });
        }
      } else {
        workspaceRows.push(row);
      }
    }

    const out = Array.from(worktreeSections.values()).map((section) => ({
      ...section,
      subtitle: worktreeSectionSubtitle(section),
    }));
    if (workspaceRows.length > 0) {
      out.push({
        key: "workspace:default",
        kind: "workspace",
        title: "Other sessions",
        subtitle: "Not attached to a worktree",
        data: workspaceRows,
      });
    }
    return out;
  }, [visibleWorkspaces]);

  const activeSections = useMemo<WorkspaceSection[]>(() => {
    if (visibleWorkspaces === null) return [];
    return buildActiveSections(visibleWorkspaces.map(buildWorkspaceRow));
  }, [visibleWorkspaces]);

  const worktreeSections = useMemo(
    () => sections.filter((section) => section.kind === "worktree"),
    [sections]
  );
  const displaySections =
    selectedView === "active" ? activeSections : worktreeSections;
  const activeCount = sectionItemCount(activeSections);
  const worktreeCount = worktreeSections.length;
  const visibleCount = visibleWorkspaces?.length ?? 0;

  const agentTargets = useMemo<AgentTarget[]>(() => {
    const activeProject =
      current !== "loading" && current !== null ? current : null;
    const activeProjectPath = projectSummaryPath(activeProject);
    const targets: AgentTarget[] = [
      {
        key: "project",
        kind: "workspace",
        label: activeProject?.name ?? "Current project",
        detail: activeProjectPath ?? "New workspace",
        cwd: activeProjectPath,
        projectId: activeProject?.id,
      },
    ];
    if (activeProject?.id) {
      targets.push({
        key: "new_worktree",
        kind: "new_worktree",
        label: activeProject.name,
        detail: activeProjectPath
          ? `Branch from HEAD · ${activeProjectPath}`
          : "Branch from current project HEAD",
        projectId: activeProject.id,
      });
    }
    for (const section of sections) {
      if (section.kind !== "worktree") continue;
      const first = section.data[0];
      targets.push({
        key: section.key,
        kind: "worktree",
        label: section.title,
        detail: first?.worktreePath ?? section.subtitle,
        cwd: first?.worktreePath ?? undefined,
        projectId: activeProject?.id,
      });
    }
    return targets;
  }, [current, sections]);
  const selectedAgentTarget = useMemo(
    () =>
      agentTargets.find((target) => target.key === selectedTargetKey) ??
      agentTargets[0],
    [agentTargets, selectedTargetKey]
  );

  if (!client) return null;

  const projectName =
    current === "loading" ? "Loading project…" : current ? current.name : "No project";
  const activeProjectPath =
    current !== "loading" ? projectSummaryPath(current) : undefined;
  const projectPath =
    activeProjectPath ?? "No project path";

  const openAgentPicker = async (targetKey = "project") => {
    if (!client) return;
    setSelectedTargetKey(
      agentTargets.some((target) => target.key === targetKey)
        ? targetKey
        : "project"
    );
    setAgentPickerOpen(true);
    if (agents === null) {
      try {
        const list = await client.listTerminalAgents();
        setAgents(list);
        setSelectedAgentId((currentId) => currentId ?? list[0]?.id ?? null);
      } catch (err) {
        Alert.alert(
          "Failed to load agents",
          String((err as Error).message ?? err)
        );
        setAgents([]);
      }
    }
  };

  const startAgent = async () => {
    if (!client || !selectedAgentId) return;
    const agent = agents?.find((item) => item.id === selectedAgentId);
    const target = selectedAgentTarget;
    if (!agent || !target) return;
    const startsNewWorktree = target.kind === "new_worktree";
    const trimmedBranch = worktreeBranchName.trim();
    if (startsNewWorktree && !target.projectId) {
      Alert.alert("No project", "Select a project before creating a worktree.");
      return;
    }
    setStartingAgent(true);
    try {
      const created = await client.createWorkspace({
        title: startsNewWorktree
          ? trimmedBranch || agent.display_name
          : agent.display_name,
        cwd: startsNewWorktree ? undefined : target.cwd,
        projectId: target.projectId,
        terminalAgentId: agent.id,
        createWorktree: startsNewWorktree,
        worktreeBranch: startsNewWorktree && trimmedBranch ? trimmedBranch : undefined,
        allowDirty: startsNewWorktree && allowDirtyWorktree,
      });
      await loadOverview();
      setOpeningId(created.workspace_id);
      const surface = await waitForTerminalSurface(client, created.workspace_id);
      if (!surface) {
        setAgentPickerOpen(false);
        Alert.alert(
          "Agent started",
          "The workspace was created, but the agent terminal has not produced output yet. Pull to refresh and open it again."
        );
        return;
      }
      const surfaceName = surfaceLabel(surface);
      const connectionId = getActiveConnectionId();
      if (connectionId) {
        await saveLastTerminal({
          connectionId,
          workspaceId: created.workspace_id,
          surfaceId: surface.id,
          workspaceName: agent.display_name,
          surfaceName,
        }).catch(() => {});
      }
      setAgentPickerOpen(false);
      router.push({
        pathname: "/connected/terminal",
        params: {
          workspaceId: created.workspace_id,
          surfaceId: surface.id,
          name: agent.display_name,
          surfaceName,
          projectName: current !== "loading" ? current?.name ?? "" : "",
          projectPath:
            current !== "loading" ? projectSummaryPath(current) ?? "" : "",
        },
      });
    } catch (err) {
      Alert.alert("Failed to start agent", String((err as Error).message ?? err));
    } finally {
      setStartingAgent(false);
      setOpeningId(null);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <Stack.Screen
        options={{
          headerTitleAlign: "left",
          headerTitle: () => (
            <Pressable
              style={({ pressed }) => [
                styles.headerProject,
                pressed && styles.headerProjectPressed,
              ]}
              onPress={openProjectPicker}
              disabled={current === "loading"}
            >
              <Text style={styles.headerProjectName} numberOfLines={1}>
                {projectName}
              </Text>
              <Text style={styles.headerProjectPath} numberOfLines={1}>
                {projectPath}
              </Text>
            </Pressable>
          ),
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                style={styles.headerAction}
                onPress={() => openAgentPicker()}
                hitSlop={8}
              >
                <Text style={styles.headerActionText}>+</Text>
              </Pressable>
              <Pressable
                style={[styles.headerAction, refreshing && styles.controlDisabled]}
                onPress={loadOverview}
                disabled={refreshing}
                hitSlop={8}
              >
                {refreshing ? (
                  <ActivityIndicator color={colors.sub} />
                ) : (
                  <Text style={styles.headerActionText}>↻</Text>
                )}
              </Pressable>
              <Pressable style={styles.headerExit} onPress={onDisconnect}>
                <Text style={styles.headerExitText}>Exit</Text>
              </Pressable>
            </View>
          ),
        }}
      />

      {loadError ? (
        <Pressable style={styles.errorBanner} onPress={loadOverview}>
          <Text style={styles.errorText} numberOfLines={2}>
            Load failed. Tap to retry. {loadError}
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.viewTabs}>
        <Pressable
          style={[
            styles.viewTab,
            selectedView === "active" && styles.viewTabActive,
          ]}
          onPress={() => setSelectedView("active")}
        >
          <Text
            style={[
              styles.viewTabText,
              selectedView === "active" && styles.viewTabTextActive,
            ]}
          >
            Project
          </Text>
          <Text style={styles.viewTabCount}>{activeCount}</Text>
        </Pressable>
        <Pressable
          style={[
            styles.viewTab,
            selectedView === "worktrees" && styles.viewTabActive,
          ]}
          onPress={() => setSelectedView("worktrees")}
        >
          <Text
            style={[
              styles.viewTabText,
              selectedView === "worktrees" && styles.viewTabTextActive,
            ]}
          >
            Worktrees
          </Text>
          <Text style={styles.viewTabCount}>{worktreeCount}</Text>
        </Pressable>
        <Pressable
          style={[
            styles.viewTab,
            selectedView === "tasks" && styles.viewTabActive,
          ]}
          onPress={() => setSelectedView("tasks")}
        >
          <Text
            style={[
              styles.viewTabText,
              selectedView === "tasks" && styles.viewTabTextActive,
            ]}
          >
            Tasks
          </Text>
        </Pressable>
      </View>

      {selectedView === "tasks" ? (
        <TasksView
          client={client}
          projectId={
            current !== "loading" && current !== null ? current.id : undefined
          }
          onOpenTask={(taskId, taskProjectId) =>
            router.push({
              pathname: "/connected/task/[id]" as never,
              params: { id: taskId, projectId: taskProjectId },
            })
          }
        />
      ) : visibleWorkspaces === null ? (
        <View style={styles.loadingPane}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>Loading sessions…</Text>
        </View>
      ) : (
        <SectionList
          sections={displaySections}
          style={styles.list}
          keyExtractor={(item) => item.ws.id}
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
          ListEmptyComponent={
            <View style={styles.emptyPane}>
              <Text style={styles.emptyTitle}>
                {selectedView === "active"
                  ? "No project agents"
                  : "No worktrees in this project"}
              </Text>
              <Text style={styles.emptyText}>
                {selectedView === "active"
                  ? visibleCount > 0
                    ? "Worktree agents are grouped in Worktrees."
                    : "Start an agent here or from TermLoop on your Mac."
                  : "Start or attach a worktree in TermLoop, then refresh."}
              </Text>
              <Pressable style={styles.emptyRefresh} onPress={loadOverview}>
                <Text style={styles.emptyRefreshText}>Refresh</Text>
              </Pressable>
            </View>
          }
          renderSectionHeader={({ section }) => {
            const context = sectionContextSummary(section, workspaceContexts);
            const showContext =
              selectedView === "worktrees" && hasSectionContext(context);
            return (
              <View style={styles.sectionHeader}>
                <View style={styles.sectionHeaderTop}>
                  <Text style={styles.sectionTitle} numberOfLines={1}>
                    {section.title}
                  </Text>
                  {section.kind === "worktree" ? (
                    <Pressable
                      style={styles.sectionAgentBtn}
                      onPress={() => openAgentPicker(section.key)}
                      hitSlop={6}
                    >
                      <Text style={styles.sectionAgentBtnText}>+ Agent</Text>
                    </Pressable>
                  ) : null}
                </View>
                <Text style={styles.sectionSubtitle} numberOfLines={1}>
                  {section.subtitle}
                </Text>
                {showContext ? (
                  <View style={styles.sectionContextLine}>
                    {context.jira ? (
                      <Text style={styles.jiraChip} numberOfLines={1}>
                        {jiraChipLabel(context.jira)}
                      </Text>
                    ) : null}
                    {context.runTargets.slice(0, 2).map((target) => (
                      <Text
                        key={`${target.label}:${target.status ?? ""}`}
                        style={styles.runTargetChip}
                        numberOfLines={1}
                      >
                        {runTargetChipLabel(target)}
                      </Text>
                    ))}
                    {context.runTargets.length > 2 ? (
                      <Text style={styles.contextMoreChip}>
                        +{context.runTargets.length - 2}
                      </Text>
                    ) : null}
                    {context.loading &&
                    !context.jira &&
                    context.runTargets.length === 0 ? (
                      <Text style={styles.contextLoadingChip}>syncing</Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          }}
          renderItem={({ item }) => {
            const isOpening = openingId === item.ws.id;
            const itemContext = workspaceContexts[item.ws.id];
            const showRowContext = selectedView === "active";
            const locationLabel = showRowContext
              ? workspaceLocationLabel(item)
              : null;
            const rowJiraLabel =
              showRowContext && itemContext?.jira
                ? jiraChipLabel(itemContext.jira)
                : null;
            const rowTargetLabel =
              showRowContext && itemContext?.runTargets[0]
                ? runTargetChipLabel(itemContext.runTargets[0])
                : null;
            const showMeta =
              locationLabel ||
              item.statusLabel ||
              item.activityLabel ||
              item.changeLabel ||
              rowJiraLabel ||
              rowTargetLabel;
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.workspaceRow,
                  item.toolLabel && styles.workspaceRowAgent,
                  pressed && styles.workspaceRowPressed,
                ]}
                onPress={() => onOpenWorkspace(item.ws)}
                disabled={openingId !== null}
              >
                <View style={styles.workspaceIcon}>
                  <Text style={styles.workspaceIconText}>
                    {item.toolLabel ? "AI" : item.sectionKind === "worktree" ? "WT" : "WS"}
                  </Text>
                </View>
                <View style={styles.workspaceBody}>
                  <Text style={styles.workspaceTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  {item.toolLabel ? (
                    <Text style={styles.toolPill} numberOfLines={1}>
                      {item.toolLabel}
                    </Text>
                  ) : null}
                  {showMeta ? (
                    <View style={styles.workspaceMetaLine}>
                      {locationLabel ? (
                        <Text style={styles.workspaceMetaChip} numberOfLines={1}>
                          {locationLabel}
                        </Text>
                      ) : null}
                      {item.statusLabel ? (
                        <Text style={styles.workspaceMetaChip} numberOfLines={1}>
                          {item.statusLabel}
                        </Text>
                      ) : null}
                      {item.activityLabel ? (
                        <Text style={styles.workspaceMetaChip} numberOfLines={1}>
                          {item.activityLabel}
                        </Text>
                      ) : null}
                      {item.changeLabel ? (
                        <Text style={styles.workspaceMetaChip} numberOfLines={1}>
                          {item.changeLabel}
                        </Text>
                      ) : null}
                      {rowJiraLabel ? (
                        <Text style={styles.workspaceJiraMetaChip} numberOfLines={1}>
                          {rowJiraLabel}
                        </Text>
                      ) : null}
                      {rowTargetLabel ? (
                        <Text
                          style={styles.workspaceTargetMetaChip}
                          numberOfLines={1}
                        >
                          {rowTargetLabel}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
                <View style={styles.openCol}>
                  {isOpening ? (
                    <ActivityIndicator color={colors.primary} />
                  ) : (
                    <>
                      <Text style={styles.openText}>Open</Text>
                      <Text style={styles.openChevron}>›</Text>
                    </>
                  )}
                </View>
              </Pressable>
            );
          }}
        />
      )}

      <Modal
        animationType="slide"
        transparent
        visible={pickerOpen}
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setPickerOpen(false)}
        >
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Switch project</Text>
            {projects === null ? (
              <ActivityIndicator style={styles.modalSpinner} />
            ) : projects.length === 0 ? (
              <Text style={styles.emptyText}>No projects available.</Text>
            ) : (
              <FlatList
                data={projects}
                keyExtractor={(p) => p.id}
                renderItem={({ item }) => {
                  const isCurrent =
                    current !== "loading" && current?.id === item.id;
                  const itemPath = projectSummaryPath(item);
                  return (
                    <Pressable
                      style={styles.projectItem}
                      onPress={() => onPickProject(item)}
                    >
                      <View style={styles.projectItemText}>
                        <Text style={styles.projectItemName} numberOfLines={1}>
                          {item.name}
                        </Text>
                        {itemPath ? (
                          <Text style={styles.projectItemPath} numberOfLines={1}>
                            {itemPath}
                          </Text>
                        ) : null}
                      </View>
                      {isCurrent ? (
                        <Text style={styles.projectCurrent}>Current</Text>
                      ) : null}
                    </Pressable>
                  );
                }}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        animationType="slide"
        transparent
        visible={agentPickerOpen}
        onRequestClose={() => setAgentPickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setAgentPickerOpen(false)}
        >
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Start agent</Text>
            <ScrollView contentContainerStyle={styles.agentSheetContent}>
              <Text style={styles.sheetLabel}>Target</Text>
              {agentTargets.map((target) => {
                const selected = selectedTargetKey === target.key;
                return (
                  <Pressable
                    key={target.key}
                    style={[
                      styles.optionRow,
                      selected && styles.optionRowSelected,
                    ]}
                    onPress={() => setSelectedTargetKey(target.key)}
                  >
                    <View style={styles.optionText}>
                      <Text style={styles.optionTitle} numberOfLines={1}>
                        {agentTargetKindLabel(target.kind)} · {target.label}
                      </Text>
                      <Text style={styles.optionSub} numberOfLines={1}>
                        {target.detail}
                      </Text>
                    </View>
                    {selected ? <Text style={styles.optionSelected}>Selected</Text> : null}
                  </Pressable>
                );
              })}
              {selectedAgentTarget?.kind === "new_worktree" ? (
                <View style={styles.worktreeCreatePanel}>
                  <Text style={styles.fieldLabel}>Branch</Text>
                  <TextInput
                    style={styles.branchInput}
                    value={worktreeBranchName}
                    onChangeText={setWorktreeBranchName}
                    placeholder="mobile/agent-task"
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Pressable
                    style={[
                      styles.toggleRow,
                      allowDirtyWorktree && styles.toggleRowActive,
                    ]}
                    onPress={() => setAllowDirtyWorktree((value) => !value)}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        allowDirtyWorktree && styles.checkboxActive,
                      ]}
                    >
                      {allowDirtyWorktree ? (
                        <Text style={styles.checkboxMark}>✓</Text>
                      ) : null}
                    </View>
                    <View style={styles.toggleText}>
                      <Text style={styles.toggleTitle}>
                        Start without taking uncommitted changes
                      </Text>
                      <Text style={styles.toggleHint} numberOfLines={2}>
                        Worktree branches off HEAD; edits stay in source.
                      </Text>
                    </View>
                  </Pressable>
                </View>
              ) : null}

              <Text style={styles.sheetLabel}>Agent</Text>
              {agents === null ? (
                <ActivityIndicator style={styles.modalSpinner} />
              ) : agents.length === 0 ? (
                <Text style={styles.emptyText}>No terminal agents available.</Text>
              ) : (
                agents.map((agent) => {
                  const selected = selectedAgentId === agent.id;
                  return (
                    <Pressable
                      key={agent.id}
                      style={[
                        styles.optionRow,
                        selected && styles.optionRowSelected,
                      ]}
                      onPress={() => setSelectedAgentId(agent.id)}
                    >
                      <View style={styles.optionText}>
                        <Text style={styles.optionTitle} numberOfLines={1}>
                          {agent.display_name}
                        </Text>
                        <Text style={styles.optionSub} numberOfLines={1}>
                          {agent.executable_name || agent.id}
                        </Text>
                      </View>
                      {selected ? <Text style={styles.optionSelected}>Selected</Text> : null}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
            <Pressable
              style={[
                styles.startAgentBtn,
                (!selectedAgentId || startingAgent) && styles.controlDisabled,
              ]}
              onPress={startAgent}
              disabled={!selectedAgentId || startingAgent}
            >
              {startingAgent ? (
                <ActivityIndicator color={colors.onPrimary} size="small" />
              ) : null}
              <Text style={styles.startAgentBtnText}>
                {startingAgent ? "Starting…" : "Start agent"}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function buildWorkspaceRow(ws: WorkspaceSummary): WorkspaceRow {
  const toolLabel = inferToolLabel(ws);
  const worktreePath = ws.worktree_path?.trim() || null;
  const branch = ws.branch?.trim() || null;
  const worktreeKey = worktreePath
    ? `worktree:path:${worktreePath}`
    : branch
      ? `worktree:branch:${branch}`
      : null;
  return {
    ws,
    title: workspaceLabel(ws),
    sectionKind: worktreeKey ? "worktree" : "workspace",
    worktreeKey,
    worktreeLabel: branch || basename(worktreePath) || null,
    worktreePath,
    toolLabel,
    statusLabel: workspaceStatusLabel(ws),
    activityLabel: workspaceActivityLabel(ws),
    changeLabel: workspaceChangeLabel(ws),
  };
}

function buildActiveSections(rows: WorkspaceRow[]): WorkspaceSection[] {
  const attention: WorkspaceRow[] = [];
  const agents: WorkspaceRow[] = [];
  const recent: WorkspaceRow[] = [];

  for (const row of rows) {
    if (row.worktreeKey) continue;
    if (!isActiveWorkspaceRow(row)) continue;
    if (workspaceNeedsAttention(row.ws)) {
      attention.push(row);
    } else if (workspaceHasAgent(row)) {
      agents.push(row);
    } else {
      recent.push(row);
    }
  }

  return [
    activeSection("active:attention", "Needs attention", attention),
    activeSection("active:agents", "Agents", agents),
    activeSection("active:recent", "Recent sessions", recent),
  ].filter((section): section is WorkspaceSection => section !== null);
}

function activeSection(
  key: string,
  title: string,
  data: WorkspaceRow[]
): WorkspaceSection | null {
  if (data.length === 0) return null;
  return {
    key,
    kind: "workspace",
    title,
    subtitle: activeSectionSubtitle(data),
    data,
  };
}

function activeSectionSubtitle(rows: WorkspaceRow[]): string {
  const count = rows.length;
  const unit = count === 1 ? "session" : "sessions";
  return `${count} ${unit}`;
}

function isActiveWorkspaceRow(row: WorkspaceRow): boolean {
  return (
    workspaceNeedsAttention(row.ws) ||
    workspaceHasAgent(row) ||
    Boolean(row.statusLabel || row.activityLabel)
  );
}

function workspaceNeedsAttention(ws: WorkspaceSummary): boolean {
  return Boolean(
    ws.awaiting_input_since || ws.last_attention_kind || ws.agent_attention_kind
  );
}

function workspaceHasAgent(row: WorkspaceRow): boolean {
  const ws = row.ws;
  return Boolean(
    row.toolLabel ||
      ws.agent ||
      ws.terminal_agent_id ||
      ws.agent_activity_phase ||
      ws.agent_activity_updated_at
  );
}

function sectionItemCount(sections: WorkspaceSection[]): number {
  return sections.reduce((sum, section) => sum + section.data.length, 0);
}

function workspaceLocationLabel(row: WorkspaceRow): string | null {
  const path = firstWorkspaceString(row.ws, ["current_directory"]);
  const base = basename(path);
  return base ? `Path ${base}` : null;
}

function workspaceCanHaveBindings(ws: WorkspaceSummary): boolean {
  return Boolean(ws.worktree_path?.trim() || ws.branch?.trim());
}

function sectionContextSummary(
  section: WorkspaceSection,
  contexts: Record<string, WorkspaceContextState>
): WorkspaceContextSummary {
  let jira: JiraTicketSummary | null = null;
  let loading = false;
  const runTargets: WorkspaceRunTargetSummary[] = [];
  const seenTargets = new Set<string>();

  for (const row of section.data) {
    const context = contexts[row.ws.id];
    if (!context) continue;
    loading = loading || context.loading;
    if (!jira && context.jira) jira = context.jira;
    for (const target of context.runTargets) {
      const key = `${target.label}:${target.status ?? ""}:${target.url ?? ""}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      runTargets.push(target);
    }
  }

  return { loading, jira, runTargets };
}

function hasSectionContext(context: WorkspaceContextSummary): boolean {
  return (
    context.loading || context.jira !== null || context.runTargets.length > 0
  );
}

function jiraChipLabel(ticket: JiraTicketSummary): string {
  const status = ticket.status?.trim();
  return status ? `Jira ${ticket.key} · ${status}` : `Jira ${ticket.key}`;
}

function runTargetChipLabel(target: WorkspaceRunTargetSummary): string {
  const status = target.status?.trim();
  return status ? `${target.label} · ${status}` : target.label;
}

function inferToolLabel(ws: WorkspaceSummary): string | null {
  const sources = [ws.agent, ws.title, ws.name];
  for (const source of sources) {
    if (!source) continue;
    const known = knownToolLabel(source);
    if (known) return known;
  }
  return ws.agent?.trim() || null;
}

function knownToolLabel(value: string): string | null {
  const v = value.toLowerCase();
  if (v.includes("codex")) return "Codex";
  if (v.includes("claude")) return "Claude";
  if (v.includes("gemini")) return "Gemini";
  if (v.includes("cursor")) return "Cursor";
  if (v.includes("aider")) return "Aider";
  if (v.includes("opencode")) return "OpenCode";
  if (v.includes("agent")) return "Agent";
  return null;
}

function workspaceStatusLabel(ws: WorkspaceSummary): string | null {
  const value =
    firstWorkspaceString(ws, [
      "agent_activity_phase",
      "last_attention_kind",
      "agent_attention_kind",
      "status",
      "state",
      "phase",
    ]) ?? (ws.terminal_agent_id ? "agent" : null);
  if (!value) return null;
  return value.replace(/[_-]+/g, " ");
}

function workspaceActivityLabel(ws: WorkspaceSummary): string | null {
  const value =
    firstWorkspaceString(ws, [
      "awaiting_input_since",
      "lastActiveAt",
      "last_active_at",
      "lastActivityAt",
      "last_activity_at",
      "updatedAt",
      "updated_at",
    ]) ??
    firstWorkspaceNumber(ws, [
      "agent_activity_updated_at",
      "awaiting_input_since",
      "lastActiveAt",
      "last_active_at",
      "updatedAt",
    ]);
  if (value === null) return null;
  return relativeTime(typeof value === "number" ? value : new Date(value), "active now");
}

function workspaceChangeLabel(ws: WorkspaceSummary): string | null {
  if (typeof ws.git_change_count !== "number" || ws.git_change_count <= 0) {
    return null;
  }
  return ws.git_change_count === 1
    ? "1 changed file"
    : `${ws.git_change_count} changed files`;
}

function firstWorkspaceString(
  ws: WorkspaceSummary,
  keys: string[]
): string | null {
  const record = ws as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstWorkspaceNumber(
  ws: WorkspaceSummary,
  keys: string[]
): number | null {
  const record = ws as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function basename(path: string | null): string | null {
  if (!path) return null;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || null;
}

function worktreeSectionSubtitle(section: WorkspaceSection): string {
  const count = section.data.length;
  const unit = count === 1 ? "session" : "sessions";
  const path = section.data.find((row) => row.worktreePath)?.worktreePath;
  return path ? `Worktree · ${count} ${unit} · ${path}` : `Worktree · ${count} ${unit}`;
}

function agentTargetKindLabel(kind: AgentTargetKind): string {
  switch (kind) {
    case "new_worktree":
      return "New worktree";
    case "worktree":
      return "Worktree";
    case "workspace":
      return "Project";
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 14,
    paddingTop: 8,
    gap: 8,
  },

  eyebrow: {
    color: colors.label,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0,
  },

  headerProject: {
    minWidth: 0,
    maxWidth: 210,
    paddingVertical: 2,
  },
  headerProjectPressed: { opacity: 0.72 },
  headerProjectName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  headerProjectPath: {
    color: colors.sub,
    fontSize: 10,
    fontFamily: monoFont,
    marginTop: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  headerAction: {
    minWidth: 30,
    minHeight: 30,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  headerActionText: {
    color: colors.primary,
    fontSize: 17,
    fontWeight: "800",
    lineHeight: 19,
  },
  controlDisabled: { opacity: 0.5 },
  headerExit: {
    minHeight: 30,
    paddingHorizontal: 8,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerDim,
    alignItems: "center",
    justifyContent: "center",
  },
  headerExitText: { color: colors.danger, fontSize: 12, fontWeight: "800" },

  errorBanner: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerDim,
  },
  errorText: { color: colors.danger, fontSize: 12, lineHeight: 16 },

  viewTabs: {
    flexDirection: "row",
    gap: 4,
    padding: 3,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  viewTab: {
    flex: 1,
    minHeight: 32,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.bgElevated,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  viewTabActive: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.bgRaised,
  },
  viewTabText: {
    color: colors.sub,
    fontSize: 12,
    fontWeight: "800",
  },
  viewTabTextActive: { color: colors.text },
  viewTabCount: {
    color: colors.hint,
    fontSize: 11,
    fontWeight: "800",
    fontFamily: monoFont,
  },

  workspacesHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  workspacesHint: { color: colors.hint, fontSize: 11 },

  loadingPane: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingText: { color: colors.sub, fontSize: 13 },
  list: { flex: 1 },
  listContent: { paddingBottom: 14, gap: 6 },
  emptyPane: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 36,
    paddingHorizontal: 20,
    gap: 8,
  },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  emptyText: {
    color: colors.sub,
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
  },
  emptyRefresh: {
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  emptyRefreshText: { color: colors.primary, fontSize: 12, fontWeight: "700" },

  sectionHeader: {
    paddingTop: 6,
    paddingBottom: 5,
  },
  sectionHeaderTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sectionTitle: { color: colors.text, fontSize: 13, fontWeight: "700" },
  sectionSubtitle: { color: colors.hint, fontSize: 11, marginTop: 1 },
  sectionContextLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 5,
    marginTop: 5,
  },
  jiraChip: {
    color: colors.warn,
    fontSize: 10,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.warn,
    backgroundColor: colors.bgRaised,
    overflow: "hidden",
    maxWidth: 170,
  },
  runTargetChip: {
    color: colors.success,
    fontSize: 10,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.successBorder,
    backgroundColor: colors.successDim,
    overflow: "hidden",
    maxWidth: 150,
  },
  contextMoreChip: {
    color: colors.hint,
    fontSize: 10,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgRaised,
    overflow: "hidden",
  },
  contextLoadingChip: {
    color: colors.hint,
    fontSize: 10,
    fontWeight: "800",
  },
  sectionAgentBtn: {
    marginLeft: "auto",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  sectionAgentBtnText: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: "800",
  },

  workspaceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 56,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    marginBottom: 7,
  },
  workspaceRowAgent: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  workspaceRowPressed: {
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgRaised,
  },
  workspaceIcon: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceIconText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: "800",
    fontFamily: monoFont,
  },
  workspaceBody: { flex: 1, minWidth: 0, gap: 4 },
  workspaceTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  toolPill: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
    overflow: "hidden",
    alignSelf: "flex-start",
    maxWidth: 120,
  },
  workspaceMetaLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 5,
  },
  workspaceMetaChip: {
    color: colors.hint,
    fontSize: 10,
    fontWeight: "700",
    maxWidth: 140,
  },
  workspaceJiraMetaChip: {
    color: colors.warn,
    fontSize: 10,
    fontWeight: "800",
    maxWidth: 150,
  },
  workspaceTargetMetaChip: {
    color: colors.success,
    fontSize: 10,
    fontWeight: "800",
    maxWidth: 150,
  },
  openCol: {
    minWidth: 46,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  openText: { color: colors.primary, fontSize: 12, fontWeight: "700" },
  openChevron: {
    color: colors.primary,
    fontSize: 22,
    lineHeight: 22,
    marginTop: -2,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
    maxHeight: "72%",
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: 12,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
  },
  modalSpinner: { marginVertical: 24 },
  projectItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  projectItemText: { flex: 1, minWidth: 0 },
  projectItemName: { color: colors.text, fontSize: 15, fontWeight: "700" },
  projectItemPath: {
    color: colors.sub,
    fontSize: 12,
    marginTop: 2,
    fontFamily: monoFont,
  },
  projectCurrent: {
    color: colors.success,
    fontSize: 11,
    fontWeight: "800",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.successDim,
    borderWidth: 1,
    borderColor: colors.successBorder,
    overflow: "hidden",
  },
  agentSheetContent: { gap: 8, paddingBottom: 12 },
  sheetLabel: {
    color: colors.label,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0,
    marginTop: 6,
  },
  fieldLabel: {
    color: colors.label,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0,
  },
  worktreeCreatePanel: {
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceBg,
  },
  branchInput: {
    minHeight: 40,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.inputBg,
    color: colors.text,
    paddingHorizontal: 10,
    fontSize: 13,
    fontFamily: monoFont,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  toggleRowActive: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  checkboxMark: {
    color: colors.onPrimary,
    fontSize: 13,
    fontWeight: "900",
    lineHeight: 16,
  },
  toggleText: { flex: 1, minWidth: 0 },
  toggleTitle: { color: colors.text, fontSize: 12, fontWeight: "700" },
  toggleHint: {
    color: colors.sub,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  optionRowSelected: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  optionText: { flex: 1, minWidth: 0 },
  optionTitle: { color: colors.text, fontSize: 13, fontWeight: "700" },
  optionSub: {
    color: colors.sub,
    fontSize: 11,
    marginTop: 2,
    fontFamily: monoFont,
  },
  optionSelected: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: "800",
  },
  startAgentBtn: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 13,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    alignItems: "center",
    marginTop: 8,
  },
  startAgentBtnText: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: "800",
  },
});
