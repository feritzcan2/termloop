import { Stack, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { saveLastTerminal } from "../../lib/last-terminal";
import {
  closeSession,
  getActiveAuth,
  getActiveClient,
  getActiveConnectionId,
} from "../../lib/session";
import {
  pickTerminalSurface,
  surfaceLabel,
  workspaceLabel,
  workspaceProjectId,
  type ProjectSummary,
  type WorkspaceSummary,
} from "../../lib/termloop-client";
import { colors, monoFont, radii } from "../../lib/theme";

type ProjectState = ProjectSummary | null | "loading";
type WorkspaceSectionKind = "worktree" | "workspace";

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

export default function ConnectedScreen() {
  const router = useRouter();
  const client = getActiveClient();
  const auth = getActiveAuth();
  const [current, setCurrent] = useState<ProjectState>("loading");
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    if (!client) return;
    setRefreshing(true);
    setLoadError(null);
    try {
      const [cur, ws] = await Promise.all([
        client.currentProject(),
        client.listWorkspaces(),
      ]);
      setCurrent(cur);
      setWorkspaces(ws);
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

  const onPickProject = async (p: ProjectSummary) => {
    if (!client) return;
    if (current !== "loading" && current?.id === p.id) {
      setPickerOpen(false);
      return;
    }
    setSwitchingId(p.id);
    try {
      await client.switchProject(p.id);
      const [cur, ws] = await Promise.all([
        client.currentProject(),
        client.listWorkspaces(),
      ]);
      setCurrent(cur);
      setWorkspaces(ws);
      setProjects(null);
      setPickerOpen(false);
    } catch (err) {
      Alert.alert(
        "Failed to switch project",
        String((err as Error).message ?? err)
      );
    } finally {
      setSwitchingId(null);
    }
  };

  const onOpenWorkspace = async (ws: WorkspaceSummary) => {
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
      const projectPath = current !== "loading" ? current?.path ?? "" : "";
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
  };

  const projectFilterId =
    current === "loading" || current === null ? null : current.id;

  const visibleWorkspaces = useMemo<WorkspaceSummary[] | null>(() => {
    if (workspaces === null) return null;
    if (!projectFilterId) return workspaces;
    return workspaces.filter(
      (ws) => workspaceProjectId(ws) === projectFilterId
    );
  }, [workspaces, projectFilterId]);

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

  if (!client) return null;

  const projectName =
    current === "loading" ? "Loading project…" : current ? current.name : "No project";
  const projectPath =
    current !== "loading" && current?.path ? current.path : "No project path";

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

      <View style={styles.workspacesHeader}>
        <Text style={styles.eyebrow}>Worktrees</Text>
        {projectFilterId && workspaces && visibleWorkspaces ? (
          <Text style={styles.workspacesHint} numberOfLines={1}>
            {visibleWorkspaces.length} of {workspaces.length}
          </Text>
        ) : null}
      </View>

      {visibleWorkspaces === null ? (
        <View style={styles.loadingPane}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>Loading sessions…</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          style={styles.list}
          keyExtractor={(item) => item.ws.id}
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
          ListEmptyComponent={
            <View style={styles.emptyPane}>
              <Text style={styles.emptyTitle}>No sessions in this project</Text>
              <Text style={styles.emptyText}>
                Start a workspace in TermLoop on your Mac, then refresh.
              </Text>
              <Pressable style={styles.emptyRefresh} onPress={loadOverview}>
                <Text style={styles.emptyRefreshText}>Refresh</Text>
              </Pressable>
            </View>
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionSubtitle} numberOfLines={1}>
                {section.subtitle}
              </Text>
            </View>
          )}
          renderItem={({ item }) => {
            const isOpening = openingId === item.ws.id;
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
                  {item.statusLabel || item.activityLabel || item.changeLabel ? (
                    <View style={styles.workspaceMetaLine}>
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
                  const isSwitching = switchingId === item.id;
                  return (
                    <Pressable
                      style={styles.projectItem}
                      onPress={() => onPickProject(item)}
                      disabled={switchingId !== null}
                    >
                      <View style={styles.projectItemText}>
                        <Text style={styles.projectItemName} numberOfLines={1}>
                          {item.name}
                        </Text>
                        {item.path ? (
                          <Text style={styles.projectItemPath} numberOfLines={1}>
                            {item.path}
                          </Text>
                        ) : null}
                      </View>
                      {isSwitching ? (
                        <ActivityIndicator color={colors.primary} />
                      ) : isCurrent ? (
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
  const date = typeof value === "number" ? dateFromNumber(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return relativeTime(date);
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

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "active now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dateFromNumber(value: number): Date {
  return new Date(value < 10_000_000_000 ? value * 1000 : value);
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
  sectionTitle: { color: colors.text, fontSize: 13, fontWeight: "700" },
  sectionSubtitle: { color: colors.hint, fontSize: 11, marginTop: 1 },

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
});
