import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { saveLastTerminal } from "../../../lib/last-terminal";
import {
  getActiveClient,
  getActiveConnectionId,
} from "../../../lib/session";
import {
  surfaceLabel,
  type TaskColumnSummary,
  type TaskRecord,
  type TerminalAgentSummary,
  type TermLoopClient,
  waitForTerminalSurface,
} from "../../../lib/termloop-client";
import { relativeTime } from "../../../lib/format";
import { colors, monoFont, radii } from "../../../lib/theme";

const COLUMN_FALLBACK: TaskColumnSummary[] = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "Todo" },
  { id: "in_progress", title: "Doing" },
  { id: "in_review", title: "Review" },
  { id: "done", title: "Done" },
];

export default function TaskDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; projectId?: string }>();
  const taskId = typeof params.id === "string" ? params.id : null;
  const projectId =
    typeof params.projectId === "string" && params.projectId.length > 0
      ? params.projectId
      : undefined;
  const client = getActiveClient();

  const [task, setTask] = useState<TaskRecord | null>(null);
  const [columns, setColumns] = useState<TaskColumnSummary[]>(COLUMN_FALLBACK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [editing, setEditing] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agents, setAgents] = useState<TerminalAgentSummary[] | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const loadedProjectId = task?.project_id;
  const refresh = useCallback(async () => {
    if (!client || !taskId) return;
    try {
      const result = await client.getTask({
        taskId,
        projectId: loadedProjectId ?? projectId,
      });
      setTask(result.task);
      setColumns(result.columns.length > 0 ? result.columns : COLUMN_FALLBACK);
      setError(null);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "not_found") {
        setTask(null);
      } else {
        setError(String((err as Error).message ?? err));
      }
    } finally {
      setLoading(false);
    }
  }, [client, taskId, projectId, loadedProjectId]);

  useEffect(() => {
    if (!client) {
      router.replace("/");
      return;
    }
    refresh();
  }, [client, refresh, router]);

  if (!client) return null;

  if (loading) {
    return (
      <SafeAreaView style={styles.root} edges={["bottom"]}>
        <Stack.Screen options={{ title: "Task" }} />
        <View style={styles.loadingPane}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>Loading task…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!task) {
    return (
      <SafeAreaView style={styles.root} edges={["bottom"]}>
        <Stack.Screen options={{ title: "Task" }} />
        <View style={styles.emptyPane}>
          <Text style={styles.emptyTitle}>Task not found</Text>
          <Text style={styles.emptyText}>
            {error ?? "It may have been archived or removed on the desktop."}
          </Text>
          <Pressable style={styles.emptyBtn} onPress={() => router.back()}>
            <Text style={styles.emptyBtnText}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const taskProjectId = task.project_id;

  const onMove = async (columnId: string) => {
    if (moving || task.column_id === columnId) return;
    setMoving(true);
    try {
      await client.moveTask({
        taskId: task.id,
        columnId,
        projectId: taskProjectId,
      });
      setTask({ ...task, column_id: columnId });
    } catch (err) {
      Alert.alert("Move failed", String((err as Error).message ?? err));
    } finally {
      setMoving(false);
    }
  };

  const onArchive = async () => {
    if (archiving) return;
    setArchiving(true);
    try {
      await client.archiveTask({
        taskId: task.id,
        projectId: taskProjectId,
      });
      router.back();
    } catch (err) {
      Alert.alert("Archive failed", String((err as Error).message ?? err));
      setArchiving(false);
    }
  };

  const openWorkspace = async (workspaceId: string) => {
    if (!client) return;
    setOpening(true);
    try {
      const surface = await waitForTerminalSurface(client, workspaceId);
      if (!surface) {
        Alert.alert(
          "Agent terminal not ready",
          "The workspace exists but no terminal surface has produced output yet. Try again."
        );
        return;
      }
      const surfaceName = surfaceLabel(surface);
      const connectionId = getActiveConnectionId();
      if (connectionId) {
        await saveLastTerminal({
          connectionId,
          workspaceId,
          surfaceId: surface.id,
          workspaceName: task.title,
          surfaceName,
        }).catch(() => {});
      }
      router.push({
        pathname: "/connected/terminal",
        params: {
          workspaceId,
          surfaceId: surface.id,
          name: task.title,
          surfaceName,
        },
      });
    } catch (err) {
      Alert.alert("Failed to open", String((err as Error).message ?? err));
    } finally {
      setOpening(false);
    }
  };

  const onOpenAgent = async () => {
    if (!task.workspace_id) return;
    await openWorkspace(task.workspace_id);
  };

  const ensureAgentsLoaded = async () => {
    if (agents !== null) return;
    try {
      const list = await client.listTerminalAgents();
      setAgents(list);
      setSelectedAgentId((current) => current ?? list[0]?.id ?? null);
    } catch (err) {
      Alert.alert(
        "Agent list unavailable",
        String((err as Error).message ?? err)
      );
      setAgents([]);
    }
  };

  const lastFailureWasDirty =
    task.provision_state === "failed" &&
    /dirty|uncommit/i.test(task.provision_failure_reason ?? "");

  const onTapStartAgent = async () => {
    setAgentPickerOpen(true);
    await ensureAgentsLoaded();
  };

  const startAgentWith = async (agentId: string | null, allowDirty: boolean) => {
    setStarting(true);
    try {
      const result = await client.startTaskAgent({
        taskId: task.id,
        terminalAgentId: agentId ?? undefined,
        projectId: taskProjectId,
        allowDirty: allowDirty || undefined,
      });
      if (result.workspace_id && result.status === "ready") {
        setAgentPickerOpen(false);
        await openWorkspace(result.workspace_id);
        await refresh();
        return;
      }
      const settled = await pollUntilSettled(client, task.id, taskProjectId);
      setTask(settled);
      if (settled.provision_state === "ready" && settled.workspace_id) {
        setAgentPickerOpen(false);
        await openWorkspace(settled.workspace_id);
        return;
      }
      Alert.alert(
        "Worktree creation failed",
        settled.provision_failure_reason ?? "Unknown error"
      );
    } catch (err) {
      Alert.alert("Start failed", String((err as Error).message ?? err));
    } finally {
      setStarting(false);
    }
  };

  const onApplyEdit = async (nextTitle: string, nextBrief: string | null) => {
    setEditing(false);
    try {
      const updated = await client.updateTask({
        taskId: task.id,
        title: nextTitle,
        brief: nextBrief,
        projectId: taskProjectId,
      });
      setTask(updated);
    } catch (err) {
      Alert.alert("Update failed", String((err as Error).message ?? err));
    }
  };

  const remoteUrl = task.remote_url ?? null;
  const ago = relativeTime(task.updated_at);
  const agentLabel = task.workspace_id ? "Bound agent" : null;
  const provisioning = task.provision_state === "pending";
  const provisionFailed = task.provision_state === "failed";

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: task.column_title,
          headerRight: () => (
            <Pressable
              style={styles.archiveBtn}
              onPress={() =>
                Alert.alert(
                  "Archive task?",
                  task.title,
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Archive", style: "destructive", onPress: onArchive },
                  ]
                )
              }
              hitSlop={10}
            >
              <Text style={styles.archiveText}>Archive</Text>
            </Pressable>
          ),
        }}
      />

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title} numberOfLines={4}>
          {task.title}
        </Text>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipLine}
          contentContainerStyle={styles.chipLineContent}
        >
          {agentLabel ? (
            <Text style={[styles.chip, styles.chipAgent]}>⚡ {agentLabel}</Text>
          ) : null}
          {task.remote_key ? (
            <Pressable
              onPress={() => remoteUrl && Linking.openURL(remoteUrl)}
              disabled={!remoteUrl}
            >
              <Text style={[styles.chip, styles.chipJira]}>
                {task.remote_key}
                {task.remote_status_label ? ` · ${task.remote_status_label}` : ""}
              </Text>
            </Pressable>
          ) : null}
          {provisioning ? (
            <Text style={[styles.chip, styles.chipPending]}>Provisioning…</Text>
          ) : null}
          {provisionFailed ? (
            <Text style={[styles.chip, styles.chipFailed]}>
              ⚠ {task.provision_failure_reason ?? "Provision failed"}
            </Text>
          ) : null}
          {ago ? <Text style={styles.chipAgo}>{ago}</Text> : null}
        </ScrollView>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.statusBar}
          contentContainerStyle={styles.statusBarContent}
        >
          {columns.map((column) => {
            const active = task.column_id === column.id;
            return (
              <Pressable
                key={column.id}
                style={[
                  styles.statusPill,
                  active && statusActiveStyleFor(column.id),
                  moving && !active && styles.statusPillBusy,
                ]}
                disabled={moving}
                onPress={() => onMove(column.id)}
              >
                <Text
                  style={[
                    styles.statusPillText,
                    active && statusActiveTextStyleFor(column.id),
                  ]}
                  numberOfLines={1}
                >
                  {column.title}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <Text style={styles.sectionLabel}>Brief</Text>
        {task.brief ? (
          <Pressable style={styles.briefBox} onPress={() => setEditing(true)}>
            <Text style={styles.briefText}>{task.brief}</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.briefBox, styles.briefEmpty]}
            onPress={() => setEditing(true)}
          >
            <Text style={styles.briefPlaceholder}>
              Tap to add context the agent will read…
            </Text>
          </Pressable>
        )}

        <Text style={styles.sectionLabel}>Workspace</Text>
        <View style={styles.kv}>
          <KvRow k="Branch" v={task.branch ?? "—"} mono />
          <KvRow k="Worktree" v={task.worktree_path ?? "—"} mono />
          <KvRow k="Workspace" v={shortId(task.workspace_id)} mono />
          {task.task_file_path ? (
            <KvRow k="Spec" v={task.task_file_path} mono />
          ) : null}
        </View>

        <View style={styles.actions}>
          {task.workspace_id ? (
            <Pressable
              style={[styles.btn, styles.btnPrimary]}
              onPress={onOpenAgent}
              disabled={opening}
            >
              {opening ? (
                <ActivityIndicator color={colors.onPrimary} size="small" />
              ) : null}
              <Text style={styles.btnPrimaryText}>
                {opening ? "Opening…" : "Open agent terminal"}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.btn, styles.btnPrimary]}
              onPress={onTapStartAgent}
              disabled={starting || provisioning}
            >
              {starting ? (
                <ActivityIndicator color={colors.onPrimary} size="small" />
              ) : null}
              <Text style={styles.btnPrimaryText}>
                {starting
                  ? "Starting…"
                  : provisioning
                    ? "Provisioning…"
                    : "Start agent on a new worktree"}
              </Text>
            </Pressable>
          )}

          <Pressable
            style={[styles.btn, styles.btnGhost]}
            onPress={() => setEditing(true)}
          >
            <Text style={styles.btnGhostText}>Edit title &amp; brief</Text>
          </Pressable>
        </View>
      </ScrollView>

      <EditTaskSheet
        visible={editing}
        initialTitle={task.title}
        initialBrief={task.brief ?? ""}
        onClose={() => setEditing(false)}
        onApply={onApplyEdit}
      />

      <AgentPickerSheet
        visible={agentPickerOpen}
        agents={agents}
        selectedId={selectedAgentId}
        onSelect={setSelectedAgentId}
        onClose={() => {
          if (starting) return;
          setAgentPickerOpen(false);
        }}
        onConfirm={startAgentWith}
        defaultAllowDirty={lastFailureWasDirty}
        starting={starting}
      />
    </SafeAreaView>
  );
}

interface KvRowProps {
  k: string;
  v: string;
  mono?: boolean;
}
function KvRow({ k, v, mono }: KvRowProps) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvKey}>{k}</Text>
      <Text style={[styles.kvVal, mono && styles.kvValMono]} numberOfLines={3}>
        {v}
      </Text>
    </View>
  );
}

interface EditSheetProps {
  visible: boolean;
  initialTitle: string;
  initialBrief: string;
  onClose: () => void;
  onApply: (title: string, brief: string | null) => void;
}
function EditTaskSheet({
  visible,
  initialTitle,
  initialBrief,
  onClose,
  onApply,
}: EditSheetProps) {
  const [title, setTitle] = useState(initialTitle);
  const [brief, setBrief] = useState(initialBrief);
  useEffect(() => {
    if (visible) {
      setTitle(initialTitle);
      setBrief(initialBrief);
    }
  }, [visible, initialTitle, initialBrief]);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onApply(t, brief.trim() || null);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>Edit task</Text>
          <Text style={styles.fieldLabel}>Title</Text>
          <TextInput
            style={styles.field}
            value={title}
            onChangeText={setTitle}
            autoFocus
          />
          <Text style={styles.fieldLabel}>Brief</Text>
          <TextInput
            style={[styles.field, styles.textarea]}
            value={brief}
            onChangeText={setBrief}
            multiline
          />
          <Pressable
            style={[styles.btn, styles.btnPrimary, { marginTop: 14 }]}
            onPress={submit}
          >
            <Text style={styles.btnPrimaryText}>Save</Text>
          </Pressable>
          <Pressable style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

interface AgentPickerSheetProps {
  visible: boolean;
  agents: TerminalAgentSummary[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onConfirm: (agentId: string | null, allowDirty: boolean) => void;
  defaultAllowDirty: boolean;
  starting: boolean;
}
function AgentPickerSheet({
  visible,
  agents,
  selectedId,
  onSelect,
  onClose,
  onConfirm,
  defaultAllowDirty,
  starting,
}: AgentPickerSheetProps) {
  const [allowDirty, setAllowDirty] = useState(defaultAllowDirty);
  useEffect(() => {
    if (visible) setAllowDirty(defaultAllowDirty);
  }, [visible, defaultAllowDirty]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>Pick agent</Text>
          <Text style={styles.sheetSub}>
            Picks the terminal agent to launch on the new worktree.
          </Text>
          {agents === null ? (
            <ActivityIndicator style={styles.agentSpinner} />
          ) : agents.length === 0 ? (
            <Text style={styles.sheetEmpty}>No terminal agents available.</Text>
          ) : (
            <ScrollView style={styles.agentList}>
              {agents.map((agent) => {
                const active = selectedId === agent.id;
                return (
                  <Pressable
                    key={agent.id}
                    style={[styles.agentRow, active && styles.agentRowActive]}
                    onPress={() => !starting && onSelect(agent.id)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.agentTitle}>{agent.display_name}</Text>
                      <Text style={styles.agentSub}>
                        {agent.executable_name ?? agent.id}
                      </Text>
                    </View>
                    {active ? (
                      <Text style={styles.agentSelected}>Selected</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          <Pressable
            style={[styles.toggleRow, allowDirty && styles.toggleRowActive]}
            onPress={() => !starting && setAllowDirty((value) => !value)}
            disabled={starting}
          >
            <View style={[styles.checkbox, allowDirty && styles.checkboxActive]}>
              {allowDirty ? <Text style={styles.checkboxMark}>✓</Text> : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleTitle}>
                Start without taking uncommitted changes
              </Text>
              <Text style={styles.toggleHint}>
                Worktree branches off HEAD; your edits stay in source.
              </Text>
            </View>
          </Pressable>
          <Pressable
            style={[
              styles.btn,
              styles.btnPrimary,
              { marginTop: 14 },
              starting && styles.btnBusy,
            ]}
            onPress={() => onConfirm(selectedId, allowDirty)}
            disabled={
              starting || (!selectedId && (agents?.length ?? 0) > 0)
            }
          >
            {starting ? (
              <ActivityIndicator color={colors.onPrimary} size="small" />
            ) : null}
            <Text style={styles.btnPrimaryText}>
              {starting
                ? "Provisioning…"
                : selectedId
                  ? "Start agent"
                  : "Skip — bind worktree only"}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.cancel, starting && styles.btnBusy]}
            onPress={onClose}
            disabled={starting}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

async function pollUntilSettled(
  client: TermLoopClient,
  taskId: string,
  projectId: string,
  timeoutMs = 60_000,
  intervalMs = 1000
): Promise<TaskRecord> {
  const start = Date.now();
  let last: TaskRecord | null = null;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const result = await client.getTask({ taskId, projectId });
    last = result.task;
    if (last.provision_state === "ready" && last.workspace_id) return last;
    if (last.provision_state === "failed") return last;
  }
  if (last) return last;
  throw new Error("Timed out waiting for worktree provisioning");
}

function statusActiveStyleFor(columnId: string) {
  switch (columnId) {
    case "todo":
      return styles.statusPillTodo;
    case "in_progress":
      return styles.statusPillDoing;
    case "in_review":
      return styles.statusPillReview;
    case "done":
      return styles.statusPillDone;
    default:
      return styles.statusPillBacklog;
  }
}
function statusActiveTextStyleFor(columnId: string) {
  switch (columnId) {
    case "todo":
      return styles.statusTextTodo;
    case "in_progress":
      return styles.statusTextDoing;
    case "in_review":
      return styles.statusTextReview;
    case "done":
      return styles.statusTextDone;
    default:
      return styles.statusTextBacklog;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 14, paddingBottom: 40 },

  loadingPane: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingText: { color: colors.sub, fontSize: 13 },

  emptyPane: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 8,
  },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  emptyText: {
    color: colors.sub,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  emptyBtn: {
    marginTop: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: radii.sm,
    backgroundColor: colors.primary,
  },
  emptyBtnText: { color: colors.onPrimary, fontSize: 13, fontWeight: "800" },

  archiveBtn: { paddingHorizontal: 8 },
  archiveText: { color: colors.danger, fontSize: 13, fontWeight: "800" },

  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 26,
    marginBottom: 8,
  },
  chipLine: {
    marginBottom: 14,
    flexGrow: 0,
  },
  chipLineContent: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    paddingRight: 14,
  },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    fontSize: 11,
    fontWeight: "800",
    borderWidth: 1,
    overflow: "hidden",
    flexShrink: 0,
  },
  chipAgent: {
    backgroundColor: colors.primaryDim,
    color: colors.primary,
    borderColor: colors.borderAccent,
  },
  chipJira: {
    backgroundColor: "rgba(230,179,71,0.13)",
    color: colors.warn,
    borderColor: "rgba(230,179,71,0.55)",
  },
  chipPending: {
    backgroundColor: colors.bgElevated,
    color: colors.warn,
    borderColor: "rgba(230,179,71,0.55)",
  },
  chipFailed: {
    backgroundColor: colors.dangerDim,
    color: colors.danger,
    borderColor: colors.dangerBorder,
  },
  chipAgo: { color: colors.hint, fontSize: 11, fontWeight: "700" },

  statusBar: {
    marginBottom: 16,
    flexGrow: 0,
  },
  statusBarContent: {
    flexDirection: "row",
    gap: 4,
    paddingRight: 14,
  },
  statusPill: {
    height: 32,
    minWidth: 64,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    flexShrink: 0,
  },
  statusPillBusy: { opacity: 0.5 },
  statusPillBacklog: {
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgRaised,
  },
  statusPillTodo: {
    borderColor: colors.primary,
    backgroundColor: "rgba(91,141,255,0.16)",
  },
  statusPillDoing: {
    borderColor: colors.warn,
    backgroundColor: "rgba(230,179,71,0.13)",
  },
  statusPillReview: {
    borderColor: "#b873ff",
    backgroundColor: "rgba(184,115,255,0.18)",
  },
  statusPillDone: {
    borderColor: colors.success,
    backgroundColor: colors.successDim,
  },
  statusPillText: {
    color: colors.sub,
    fontSize: 11,
    fontWeight: "800",
  },
  statusTextBacklog: { color: colors.text },
  statusTextTodo: { color: colors.primary },
  statusTextDoing: { color: colors.warn },
  statusTextReview: { color: "#b873ff" },
  statusTextDone: { color: colors.success },

  sectionLabel: {
    color: colors.label,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 8,
    marginBottom: 6,
  },
  briefBox: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceBg,
    padding: 12,
  },
  briefEmpty: { backgroundColor: colors.bgElevated },
  briefText: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 18,
  },
  briefPlaceholder: {
    color: colors.placeholder,
    fontSize: 13,
    fontStyle: "italic",
  },

  kv: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  kvRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 6,
    gap: 12,
  },
  kvKey: {
    width: 80,
    color: colors.label,
    fontSize: 12,
    fontWeight: "700",
  },
  kvVal: { flex: 1, color: colors.text, fontSize: 12 },
  kvValMono: { fontFamily: monoFont, fontSize: 11 },

  actions: { gap: 8, marginTop: 16 },
  btn: {
    height: 46,
    borderRadius: radii.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  btnPrimary: { backgroundColor: colors.primary },
  btnPrimaryText: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: "800",
  },
  btnGhost: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  btnGhostText: { color: colors.text, fontSize: 14, fontWeight: "700" },

  // Sheet
  sheetBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: 12,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 6,
  },
  sheetSub: {
    color: colors.sub,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 12,
  },
  fieldLabel: {
    color: colors.label,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    marginTop: 8,
    marginBottom: 6,
  },
  field: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  textarea: { minHeight: 100, textAlignVertical: "top" },

  cancel: {
    marginTop: 8,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { color: colors.sub, fontSize: 13, fontWeight: "700" },

  toggleRow: {
    marginTop: 12,
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
    borderRadius: 4,
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
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 14,
  },
  toggleTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  toggleHint: {
    color: colors.sub,
    fontSize: 11,
    marginTop: 2,
  },
  btnBusy: { opacity: 0.7 },

  agentList: { maxHeight: 320 },
  agentSpinner: { marginVertical: 24 },
  sheetEmpty: { color: colors.sub, fontSize: 13, marginVertical: 16 },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    marginBottom: 6,
  },
  agentRowActive: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  agentTitle: { color: colors.text, fontSize: 13, fontWeight: "700" },
  agentSub: {
    color: colors.sub,
    fontSize: 11,
    fontFamily: monoFont,
    marginTop: 2,
  },
  agentSelected: { color: colors.primary, fontSize: 11, fontWeight: "800" },
});
