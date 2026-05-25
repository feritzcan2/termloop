import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  type ListRenderItem,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  type TaskColumnSummary,
  type TaskRecord,
  type TaskRemoteContext,
  type TermLoopClient,
} from "../lib/termloop-client";
import { relativeTime } from "../lib/format";
import { colors, monoFont, radii } from "../lib/theme";

interface TasksViewProps {
  client: TermLoopClient;
  projectId?: string;
  onOpenTask: (taskId: string, projectId: string) => void;
}

const ROW_HEIGHT = 92;
const ALL_FILTER = "__all__" as const;

type ColumnFilter = typeof ALL_FILTER | string;

export function TasksView({
  client,
  projectId,
  onOpenTask,
}: TasksViewProps) {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [columns, setColumns] = useState<TaskColumnSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ColumnFilter>(ALL_FILTER);
  const [search, setSearch] = useState("");
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [remoteContext, setRemoteContext] = useState<TaskRemoteContext | null>(
    null
  );
  const [remoteBusy, setRemoteBusy] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const [out, context] = await Promise.all([
        client.listTasks({ projectId, includeArchived: false }),
        client
          .getTaskRemoteContext({ projectId })
          .catch(() => null),
      ]);
      setTasks(out.tasks);
      setColumns(out.columns);
      setRemoteContext(context);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setRefreshing(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    setTasks(null);
    load();
  }, [load]);

  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    let total = 0;
    if (!tasks) return { byColumn: result, total: 0 };
    for (const task of tasks) {
      total += 1;
      result[task.column_id] = (result[task.column_id] ?? 0) + 1;
    }
    return { byColumn: result, total };
  }, [tasks]);

  const filtered = useMemo<TaskRecord[]>(() => {
    if (!tasks) return [];
    const trimmed = search.trim().toLowerCase();
    let list = tasks;
    if (filter !== ALL_FILTER) list = list.filter((t) => t.column_id === filter);
    if (trimmed) {
      list = list.filter((t) => {
        if (t.title.toLowerCase().includes(trimmed)) return true;
        if (t.branch?.toLowerCase().includes(trimmed)) return true;
        if (t.remote_key?.toLowerCase().includes(trimmed)) return true;
        if (t.brief && t.brief.toLowerCase().includes(trimmed)) return true;
        return false;
      });
    }
    const columnOrder = new Map<string, number>();
    columns.forEach((column, index) => columnOrder.set(column.id, index));
    return [...list].sort((a, b) => {
      const ai = columnOrder.get(a.column_id) ?? 999;
      const bi = columnOrder.get(b.column_id) ?? 999;
      if (ai !== bi) return ai - bi;
      if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
      return a.created_at - b.created_at;
    });
  }, [tasks, filter, search, columns]);

  const renderItem = useCallback<ListRenderItem<TaskRecord>>(
    ({ item }) => (
      <TaskRow
        item={item}
        onPress={() => onOpenTask(item.id, item.project_id)}
      />
    ),
    [onOpenTask]
  );

  const onCreated = useCallback(
    (created: TaskRecord) => {
      setTasks((prev) => (prev ? [created, ...prev] : [created]));
      setCreatorOpen(false);
    },
    []
  );

  const onSyncAssigned = useCallback(async () => {
    if (!remoteContext || remoteBusy) return;
    setRemoteBusy(true);
    try {
      const op = await client.syncAssignedRemoteTasks({ projectId });
      const settled = await client.waitRemoteOperation(op.operation_id, 60_000);
      const result = settled.result;
      if (result?.tasks) setTasks(result.tasks);
      if (result?.context) setRemoteContext(result.context);
      if (!result?.tasks) await load();
    } catch (err) {
      Alert.alert("Remote sync failed", String((err as Error).message ?? err));
    } finally {
      setRemoteBusy(false);
    }
  }, [client, projectId, remoteContext, remoteBusy, load]);

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <RemoteSyncBar
          context={remoteContext}
          busy={remoteBusy}
          onSync={onSyncAssigned}
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          <Chip
            label="All"
            count={counts.total}
            active={filter === ALL_FILTER}
            onPress={() => setFilter(ALL_FILTER)}
          />
          {columns.map((column) => {
            const count = counts.byColumn[column.id] ?? 0;
            return (
              <Chip
                key={column.id}
                label={column.title}
                count={count}
                active={filter === column.id}
                onPress={() => setFilter(column.id)}
              />
            );
          })}
        </ScrollView>

        <View style={styles.searchRow}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search title, brief, branch, Jira…"
            placeholderTextColor={colors.placeholder}
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {search ? (
            <Pressable
              onPress={() => setSearch("")}
              style={styles.searchClear}
              hitSlop={8}
            >
              <Text style={styles.searchClearText}>×</Text>
            </Pressable>
          ) : (
            <Text style={styles.searchMeta}>{filtered.length}</Text>
          )}
        </View>
      </View>

      {error ? (
        <Pressable style={styles.errorBanner} onPress={load}>
          <Text style={styles.errorText} numberOfLines={2}>
            Load failed. Tap to retry. {error}
          </Text>
        </Pressable>
      ) : null}

      {tasks === null ? (
        <View style={styles.loadingPane}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>Loading tasks…</Text>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyPane}>
          <Text style={styles.emptyTitle}>
            {tasks.length === 0 ? "No tasks yet" : "No matches"}
          </Text>
          <Text style={styles.emptyText}>
            {tasks.length === 0
              ? "Capture an idea — a task here can later spawn an agent on its own worktree."
              : "Adjust the filter or clear the search."}
          </Text>
          {tasks.length === 0 ? (
            <Pressable
              style={styles.emptyCreateBtn}
              onPress={() => setCreatorOpen(true)}
            >
              <Text style={styles.emptyCreateText}>Create first task</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          getItemLayout={(_, index) => ({
            length: ROW_HEIGHT,
            offset: ROW_HEIGHT * index,
            index,
          })}
          contentContainerStyle={styles.listContent}
          removeClippedSubviews
          windowSize={11}
          initialNumToRender={20}
          maxToRenderPerBatch={15}
          refreshing={refreshing}
          onRefresh={load}
        />
      )}

      <View style={styles.scaleBanner} pointerEvents="none">
        <Text style={styles.scaleBannerText}>
          {tasks ? `Showing ${filtered.length} of ${tasks.length}` : ""}
        </Text>
      </View>

      <Pressable
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        onPress={() => setCreatorOpen(true)}
      >
        <Text style={styles.fabText}>+</Text>
      </Pressable>

      <NewTaskSheet
        visible={creatorOpen}
        client={client}
        projectId={projectId}
        columns={columns}
        remoteContext={remoteContext}
        onClose={() => setCreatorOpen(false)}
        onCreated={onCreated}
      />
    </View>
  );
}

interface ChipProps {
  label: string;
  count?: number;
  active: boolean;
  onPress: () => void;
  mono?: boolean;
}

function Chip({ label, count, active, onPress, mono }: ChipProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text
        style={[
          styles.chipLabel,
          active && styles.chipLabelActive,
          mono && styles.chipLabelMono,
        ]}
      >
        {label}
      </Text>
      {count !== undefined ? (
        <Text style={[styles.chipCount, active && styles.chipCountActive]}>
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

interface RemoteSyncBarProps {
  context: TaskRemoteContext | null;
  busy: boolean;
  onSync: () => void;
}

function RemoteSyncBar({ context, busy, onSync }: RemoteSyncBarProps) {
  if (!context) return null;
  const provider = context.provider_label || context.provider || "Remote";
  const enabled = context.enabled;
  const canSync = context.can_sync_assigned && !busy && !context.is_syncing;
  const status = !enabled
    ? "Off on Mac"
    : context.is_syncing || busy
      ? "Syncing…"
      : context.last_error
        ? "Error"
        : context.last_synced_at
          ? `Synced ${relativeTime(context.last_synced_at)}`
          : context.sync_assigned_enabled
            ? "Not synced"
            : "Manual links";
  return (
    <View
      style={[
        styles.remoteBar,
        context.last_error && styles.remoteBarError,
        !enabled && styles.remoteBarDisabled,
      ]}
    >
      <View style={styles.remoteBarText}>
        <Text style={styles.remoteBarTitle} numberOfLines={1}>
          {provider}
          {context.container ? ` · ${context.container}` : ""}
        </Text>
        <Text style={styles.remoteBarSub} numberOfLines={1}>
          {context.last_error || context.last_message || status}
        </Text>
      </View>
      {enabled ? (
        <Pressable
          style={[styles.remoteSyncBtn, !canSync && styles.remoteSyncBtnOff]}
          onPress={onSync}
          disabled={!canSync}
        >
          {busy || context.is_syncing ? (
            <ActivityIndicator color={colors.primary} size="small" />
          ) : (
            <Text style={styles.remoteSyncText}>Sync</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

interface TaskRowProps {
  item: TaskRecord;
  onPress: () => void;
}

function TaskRow({ item, onPress }: TaskRowProps) {
  const tone = rowTone(item);
  const agentLabel = inferAgentLabel(item);
  const ago = relativeTime(item.updated_at);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        tone === "agent" && styles.rowAgent,
        tone === "attention" && styles.rowAttention,
        tone === "failed" && styles.rowFailed,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={[styles.rail, railStyleFor(item.column_id)]} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.title}
        </Text>
        {item.brief ? (
          <Text style={styles.rowBrief} numberOfLines={2}>
            {item.brief}
          </Text>
        ) : null}
        <View style={styles.rowMeta}>
          <Text style={[styles.pill, styles.pillCol]} numberOfLines={1}>
            <Text style={[styles.dot, dotStyleFor(item.column_id)]}>● </Text>
            {item.column_title}
          </Text>
          {agentLabel ? (
            <Text style={[styles.pill, styles.pillAgent]} numberOfLines={1}>
              ⚡ {agentLabel}
            </Text>
          ) : null}
          {item.branch ? (
            <Text style={[styles.pill, styles.pillBranch]} numberOfLines={1}>
              {item.branch}
            </Text>
          ) : null}
          {item.remote_key ? (
            <Text style={[styles.pill, styles.pillJira]} numberOfLines={1}>
              {item.remote_key}
              {item.remote_status_label ? ` · ${item.remote_status_label}` : ""}
            </Text>
          ) : null}
          {item.provision_state === "pending" ? (
            <Text style={[styles.pill, styles.pillPending]} numberOfLines={1}>
              provisioning…
            </Text>
          ) : null}
          {item.provision_state === "failed" ? (
            <Text style={[styles.pill, styles.pillFailed]} numberOfLines={1}>
              ⚠ {item.provision_failure_reason ?? "failed"}
            </Text>
          ) : null}
          {ago ? (
            <Text style={styles.pillAgo} numberOfLines={1}>
              {ago}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.rowAside}>
        <Text style={styles.chev}>›</Text>
      </View>
    </Pressable>
  );
}

interface NewTaskSheetProps {
  visible: boolean;
  client: TermLoopClient;
  projectId?: string;
  columns: TaskColumnSummary[];
  remoteContext: TaskRemoteContext | null;
  onClose: () => void;
  onCreated: (task: TaskRecord) => void;
}

function NewTaskSheet({
  visible,
  client,
  projectId,
  columns,
  remoteContext,
  onClose,
  onCreated,
}: NewTaskSheetProps) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [columnId, setColumnId] = useState("backlog");
  const [createRemote, setCreateRemote] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setTitle("");
      setBrief("");
      setColumnId("backlog");
      setCreateRemote(false);
      setError(null);
      setSubmitting(false);
    }
  }, [visible]);

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      let created: TaskRecord;
      if (createRemote && remoteContext?.can_create) {
        const op = await client.createRemoteTask({
          title: trimmedTitle,
          bodyMarkdown: brief.trim() || undefined,
          projectId,
        });
        const settled = await client.waitRemoteOperation(op.operation_id, 60_000);
        const task = settled.result?.task;
        if (!task) throw new Error("Remote item was created but no task returned.");
        created = task;
      } else {
        created = await client.createTask({
          title: trimmedTitle,
          brief: brief.trim() || undefined,
          columnId,
          projectId,
        });
      }
      onCreated(created);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setSubmitting(false);
    }
  };

  const pickerColumns = columns.length > 0 ? columns : DEFAULT_COLUMN_PICKER;
  const remoteCreateAvailable = Boolean(remoteContext?.enabled && remoteContext.can_create);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.sheetKav}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.sheetBackdrop} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.sheetScrollContent}
            >
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>New task</Text>

              <Text style={styles.fieldLabel}>Title</Text>
              <TextInput
                style={styles.field}
                placeholder="What needs to happen?"
                placeholderTextColor={colors.placeholder}
                value={title}
                onChangeText={setTitle}
                autoFocus
              />

              <Text style={styles.fieldLabel}>Brief (optional)</Text>
              <TextInput
                style={[styles.field, styles.textarea]}
                placeholder="Additional context the agent will read…"
                placeholderTextColor={colors.placeholder}
                value={brief}
                onChangeText={setBrief}
                multiline
              />

              <Text style={styles.fieldLabel}>Column</Text>
              <View style={styles.colPicker}>
                {pickerColumns.slice(0, 5).map((column) => {
                  const active = columnId === column.id;
                  return (
                    <Pressable
                      key={column.id}
                      style={[styles.colOpt, active && styles.colOptActive]}
                      onPress={() => setColumnId(column.id)}
                    >
                      <View style={[styles.colDot, dotBgStyleFor(column.id)]} />
                      <Text
                        style={[
                          styles.colOptText,
                          active && styles.colOptTextActive,
                        ]}
                        numberOfLines={1}
                      >
                        {column.title}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {remoteContext?.enabled ? (
                <Pressable
                  style={[
                    styles.remoteCreateToggle,
                    createRemote && styles.remoteCreateToggleOn,
                    !remoteCreateAvailable && styles.remoteCreateToggleOff,
                  ]}
                  onPress={() =>
                    remoteCreateAvailable &&
                    setCreateRemote((value) => !value)
                  }
                  disabled={!remoteCreateAvailable}
                >
                  <View
                    style={[
                      styles.checkbox,
                      createRemote && styles.checkboxActive,
                    ]}
                  >
                    {createRemote ? (
                      <Text style={styles.checkboxMark}>✓</Text>
                    ) : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.remoteCreateTitle}>
                      Create {remoteContext.provider_label || remoteContext.provider} item too
                    </Text>
                    <Text style={styles.remoteCreateHint} numberOfLines={2}>
                      {remoteCreateAvailable
                        ? "Creates the remote issue and links it to this task."
                        : remoteContext.cli_summary || "Remote creation is unavailable on the Mac."}
                    </Text>
                  </View>
                </Pressable>
              ) : null}

              {error ? (
                <Text style={styles.sheetError} numberOfLines={3}>
                  {error}
                </Text>
              ) : null}

              <Pressable
                style={[styles.submit, !canSubmit && styles.submitDisabled]}
                disabled={!canSubmit}
                onPress={submit}
              >
                {submitting ? (
                  <ActivityIndicator color={colors.onPrimary} size="small" />
                ) : null}
                <Text style={styles.submitText}>
                  {submitting ? "Creating…" : "Create task"}
                </Text>
              </Pressable>
              <Pressable style={styles.cancel} onPress={onClose}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const DEFAULT_COLUMN_PICKER: TaskColumnSummary[] = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "Todo" },
  { id: "in_progress", title: "Doing" },
  { id: "in_review", title: "Review" },
  { id: "done", title: "Done" },
];

function rowTone(task: TaskRecord): "agent" | "attention" | "failed" | "plain" {
  if (task.provision_state === "failed") return "failed";
  if (task.provision_state === "pending") return "attention";
  if (task.workspace_id) return "agent";
  return "plain";
}

function inferAgentLabel(task: TaskRecord): string | null {
  if (!task.workspace_id) return null;
  if (task.title) {
    const lower = task.title.toLowerCase();
    if (lower.includes("codex")) return "Codex";
    if (lower.includes("claude")) return "Claude";
    if (lower.includes("gemini")) return "Gemini";
  }
  return "Agent";
}

function railStyleFor(columnId: string) {
  switch (columnId) {
    case "todo":
      return styles.railTodo;
    case "in_progress":
      return styles.railDoing;
    case "in_review":
      return styles.railReview;
    case "done":
      return styles.railDone;
    default:
      return styles.railBacklog;
  }
}

function dotStyleFor(columnId: string) {
  switch (columnId) {
    case "todo":
      return styles.dotTodo;
    case "in_progress":
      return styles.dotDoing;
    case "in_review":
      return styles.dotReview;
    case "done":
      return styles.dotDone;
    default:
      return styles.dotBacklog;
  }
}

function dotBgStyleFor(columnId: string) {
  switch (columnId) {
    case "todo":
      return styles.dotBgTodo;
    case "in_progress":
      return styles.dotBgDoing;
    case "in_review":
      return styles.dotBgReview;
    case "done":
      return styles.dotBgDone;
    default:
      return styles.dotBgBacklog;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, position: "relative" },
  toolbar: { paddingTop: 4, gap: 8 },
  remoteBar: {
    minHeight: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  remoteBarError: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerDim,
  },
  remoteBarDisabled: { opacity: 0.72 },
  remoteBarText: { flex: 1, minWidth: 0 },
  remoteBarTitle: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "800",
  },
  remoteBarSub: {
    color: colors.sub,
    fontSize: 10,
    marginTop: 2,
  },
  remoteSyncBtn: {
    minWidth: 56,
    minHeight: 30,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  remoteSyncBtnOff: { opacity: 0.45 },
  remoteSyncText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  chipRow: { gap: 6, paddingHorizontal: 2, paddingBottom: 2 },
  chip: {
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  chipActive: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  chipLabel: { color: colors.sub, fontSize: 11, fontWeight: "800" },
  chipLabelActive: { color: colors.primary },
  chipLabelMono: { fontFamily: monoFont, fontSize: 10 },
  chipCount: {
    color: colors.hint,
    fontSize: 10,
    fontFamily: monoFont,
    backgroundColor: colors.bg,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
  },
  chipCountActive: {
    color: colors.primary,
    backgroundColor: "rgba(91,141,255,0.18)",
  },

  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.inputBg,
    gap: 8,
  },
  searchIcon: { color: colors.sub, fontSize: 15 },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    paddingVertical: 0,
  },
  searchMeta: {
    color: colors.hint,
    fontSize: 10,
    fontFamily: monoFont,
  },
  searchClear: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: colors.bgRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  searchClearText: { color: colors.text, fontSize: 14, lineHeight: 14 },

  errorBanner: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerDim,
  },
  errorText: { color: colors.danger, fontSize: 12, lineHeight: 16 },

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
    gap: 8,
    paddingHorizontal: 28,
  },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  emptyText: {
    color: colors.sub,
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
  },
  emptyCreateBtn: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  emptyCreateText: { color: colors.primary, fontSize: 12, fontWeight: "800" },

  listContent: { paddingTop: 8, paddingBottom: 80 },

  row: {
    minHeight: ROW_HEIGHT - 7,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    marginBottom: 7,
  },
  rowAgent: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  rowAttention: {
    borderColor: "rgba(230,179,71,0.55)",
    backgroundColor: "rgba(230,179,71,0.13)",
  },
  rowFailed: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerDim,
  },
  rowPressed: {
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgRaised,
  },

  rail: { width: 3, alignSelf: "stretch", borderRadius: 2 },
  railBacklog: { backgroundColor: colors.hint },
  railTodo: { backgroundColor: colors.primary },
  railDoing: { backgroundColor: colors.warn },
  railReview: { backgroundColor: "#b873ff" },
  railDone: { backgroundColor: colors.success },

  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
  rowBrief: {
    color: colors.sub,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 3,
  },
  rowMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 5,
    marginTop: 7,
  },
  pill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    fontSize: 10,
    fontWeight: "800",
    borderWidth: 1,
    overflow: "hidden",
    maxWidth: 170,
  },
  pillCol: {
    backgroundColor: colors.bg,
    color: colors.label,
    borderColor: colors.border,
  },
  dot: { fontSize: 10 },
  dotBacklog: { color: colors.hint },
  dotTodo: { color: colors.primary },
  dotDoing: { color: colors.warn },
  dotReview: { color: "#b873ff" },
  dotDone: { color: colors.success },
  dotBgBacklog: { backgroundColor: colors.hint },
  dotBgTodo: { backgroundColor: colors.primary },
  dotBgDoing: { backgroundColor: colors.warn },
  dotBgReview: { backgroundColor: "#b873ff" },
  dotBgDone: { backgroundColor: colors.success },

  pillAgent: {
    backgroundColor: colors.primaryDim,
    color: colors.primary,
    borderColor: colors.borderAccent,
  },
  pillBranch: {
    backgroundColor: colors.bg,
    color: colors.sub,
    borderColor: colors.border,
    fontFamily: monoFont,
    fontSize: 10,
  },
  pillJira: {
    backgroundColor: "rgba(230,179,71,0.13)",
    color: colors.warn,
    borderColor: "rgba(230,179,71,0.55)",
  },
  pillPending: {
    backgroundColor: colors.bg,
    color: colors.warn,
    borderColor: "rgba(230,179,71,0.55)",
  },
  pillFailed: {
    backgroundColor: colors.dangerDim,
    color: colors.danger,
    borderColor: colors.dangerBorder,
  },
  pillAgo: {
    color: colors.hint,
    fontSize: 10,
    fontWeight: "700",
  },

  rowAside: {
    minWidth: 22,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  chev: { color: colors.primary, fontSize: 22, lineHeight: 22 },

  scaleBanner: {
    position: "absolute",
    left: 0,
    right: 86,
    bottom: 14,
    height: 30,
    borderRadius: radii.sm,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  scaleBannerText: {
    color: colors.sub,
    fontSize: 11,
    fontWeight: "700",
  },

  fab: {
    position: "absolute",
    right: 6,
    bottom: 14,
    width: 54,
    height: 54,
    borderRadius: 999,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 20,
    elevation: 8,
  },
  fabPressed: { opacity: 0.85 },
  fabText: {
    color: colors.onPrimary,
    fontSize: 28,
    fontWeight: "700",
    lineHeight: 30,
  },

  // Sheet
  sheetKav: { flex: 1 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    maxHeight: "90%",
  },
  sheetScrollContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 28,
  },
  sheetHandle: {
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
  textarea: { minHeight: 88, textAlignVertical: "top" },
  colPicker: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  colOpt: {
    flexBasis: "31%",
    flexGrow: 1,
    height: 36,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgRaised,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 8,
  },
  colOptActive: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  colOptText: { color: colors.sub, fontSize: 11, fontWeight: "800" },
  colOptTextActive: { color: colors.primary },
  colDot: { width: 6, height: 6, borderRadius: 999 },
  remoteCreateToggle: {
    marginTop: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgRaised,
    padding: 10,
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  remoteCreateToggleOn: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  remoteCreateToggleOff: { opacity: 0.58 },
  checkbox: {
    width: 22,
    height: 22,
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
    fontSize: 14,
    fontWeight: "900",
  },
  remoteCreateTitle: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "800",
  },
  remoteCreateHint: {
    color: colors.sub,
    fontSize: 10,
    marginTop: 2,
    lineHeight: 14,
  },

  sheetError: {
    color: colors.danger,
    fontSize: 12,
    marginTop: 10,
  },
  submit: {
    marginTop: 16,
    height: 46,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: "800",
  },
  cancel: {
    marginTop: 8,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { color: colors.sub, fontSize: 13, fontWeight: "700" },
});
