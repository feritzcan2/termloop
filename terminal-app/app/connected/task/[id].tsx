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
  mergeTaskColumns,
  surfaceLabel,
  taskColumnsFromTasks,
  taskRemoteContextColumns,
  type TaskColumnSummary,
  type PullRequestSummary,
  type TaskRecord,
  type TaskRemoteContext,
  type TerminalAgentSummary,
  type TermLoopClient,
  type WorkspaceSummary,
  waitForTerminalSurface,
  workspaceLabel,
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
  const [savingEdit, setSavingEdit] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBrief, setDraftBrief] = useState("");
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteLinkOpen, setRemoteLinkOpen] = useState(false);
  const [remoteContext, setRemoteContext] = useState<TaskRemoteContext | null>(
    null
  );
  const [taskWorkspaces, setTaskWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agents, setAgents] = useState<TerminalAgentSummary[] | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentPromptText, setAgentPromptText] = useState("");
  const [agentPlanMode, setAgentPlanMode] = useState(false);

  const loadedProjectId = task?.project_id;
  const refresh = useCallback(async () => {
    if (!client || !taskId) return;
    try {
      const [result, workspaces] = await Promise.all([
        client.getTask({
          taskId,
          projectId: loadedProjectId ?? projectId,
        }),
        client.listWorkspaces().catch(() => []),
      ]);
      setTask(result.task);
      setTaskWorkspaces(taskMatchingWorkspaces(result.task, workspaces));
      setColumns(
        mergeTaskColumns(
          result.columns.length > 0 ? result.columns : COLUMN_FALLBACK,
          taskColumnsFromTasks([result.task])
        )
      );
      client
        .getTaskRemoteContext({ projectId: result.task.project_id })
        .then((context) => {
          setRemoteContext(context);
          setColumns((current) =>
            mergeTaskColumns(current, taskRemoteContextColumns(context))
          );
        })
        .catch(() => setRemoteContext(null));
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

  useEffect(() => {
    if (!task) return;
    setDraftTitle(task.title);
    setDraftBrief(task.brief ?? "");
  }, [task?.id, task?.title, task?.brief]);

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
      const nextColumn = columns.find((column) => column.id === columnId);
      const nextTask = {
        ...task,
        column_id: columnId,
        column_title: nextColumn?.title ?? task.column_title,
      };
      setTask(nextTask);
      const remoteStatus = nextColumn?.remote_status_label;
      if (task.remote_key && remoteContext?.enabled && remoteStatus) {
        Alert.alert(
          "Update remote status?",
          `Also move ${task.remote_key} to ${remoteStatus}?`,
          [
            { text: "Not now", style: "cancel" },
            {
              text: "Update",
              onPress: () => {
                updateRemoteStatus(nextTask);
              },
            },
          ]
        );
      }
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

  const onOpenChanges = () => {
    if (!task?.workspace_id && !task?.worktree_path) return;
    router.push({
      pathname: "/connected/changes" as never,
      params: {
        ...(task.workspace_id ? { workspaceId: task.workspace_id } : {}),
        ...(task.worktree_path ? { worktreePath: task.worktree_path } : {}),
        ...(task.branch ? { branch: task.branch } : {}),
        name: task.branch ?? task.title,
      },
    });
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
    if (task) setAgentPromptText(defaultTaskAgentPrompt(task));
    setAgentPickerOpen(true);
    await ensureAgentsLoaded();
  };

  const startAgentWith = async (
    agentId: string | null,
    allowDirty: boolean,
    promptText: string,
    planMode: boolean
  ) => {
    const trimmedPrompt = promptText.trim();
    setStarting(true);
    try {
      const result = await client.startTaskAgent({
        taskId: task.id,
        terminalAgentId: agentId ?? undefined,
        projectId: taskProjectId,
        allowDirty: allowDirty || undefined,
        promptText: trimmedPrompt || undefined,
        planMode,
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

  const onApplyEdit = async () => {
    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      Alert.alert("Title required", "Enter a title before saving.");
      return;
    }
    const nextBrief = draftBrief.trim() || null;
    setSavingEdit(true);
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
    } finally {
      setSavingEdit(false);
    }
  };

  const applyRemoteTaskResult = (result: {
    task?: TaskRecord;
    context?: TaskRemoteContext;
  }) => {
    if (result.task) setTask(result.task);
    if (result.context) setRemoteContext(result.context);
    if (result.task || result.context) {
      setColumns((current) =>
        mergeTaskColumns(
          current,
          taskRemoteContextColumns(result.context),
          taskColumnsFromTasks(result.task ? [result.task] : null)
        )
      );
    }
  };

  const waitForRemoteTask = async (operationId: string) => {
    const settled = await client.waitRemoteOperation(operationId, 60_000);
    applyRemoteTaskResult(settled.result ?? {});
    return settled.result;
  };

  const refreshRemote = async () => {
    if (!task.remote_key || remoteBusy) return;
    setRemoteBusy(true);
    try {
      const op = await client.refreshTaskRemoteItem({
        taskId: task.id,
        projectId: taskProjectId,
      });
      await waitForRemoteTask(op.operation_id);
    } catch (err) {
      Alert.alert("Refresh failed", String((err as Error).message ?? err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const linkRemote = async (input: string) => {
    if (remoteBusy) return;
    setRemoteBusy(true);
    try {
      const op = await client.linkTaskRemoteItem({
        taskId: task.id,
        input,
        projectId: taskProjectId,
      });
      await waitForRemoteTask(op.operation_id);
      setRemoteLinkOpen(false);
    } catch (err) {
      Alert.alert("Link failed", String((err as Error).message ?? err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const updateRemoteStatus = async (sourceTask: TaskRecord = task) => {
    if (!sourceTask.remote_key || remoteBusy) return;
    setRemoteBusy(true);
    try {
      const op = await client.updateTaskRemoteStatus({
        taskId: sourceTask.id,
        columnId: sourceTask.column_id,
        projectId: sourceTask.project_id,
      });
      await waitForRemoteTask(op.operation_id);
    } catch (err) {
      Alert.alert("Remote update failed", String((err as Error).message ?? err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const remoteUrl = task.remote_url ?? null;
  const ago = relativeTime(task.updated_at);
  const agentLabel = task.workspace_id ? "Bound agent" : null;
  const provisioning = task.provision_state === "pending";
  const provisionFailed = task.provision_state === "failed";
  const providerName =
    remoteContext?.provider_label ||
    task.remote_provider?.replace(/^\w/, (c) => c.toUpperCase()) ||
    "Remote";
  const remoteDescription = task.remote_description?.trim() || null;
  const titleDirty = draftTitle.trim() !== task.title;
  const briefDirty = (draftBrief.trim() || null) !== (task.brief ?? null);
  const canSaveEdit = (titleDirty || briefDirty) && draftTitle.trim().length > 0 && !savingEdit;
  const changeCount = task.git_change_count ?? 0;
  const canOpenChanges = Boolean(task.worktree_path || task.workspace_id);
  const openPullRequests = taskOpenPullRequests(task);
  const openPullRequest = (pullRequest: PullRequestSummary) => {
    if (pullRequest.url) Linking.openURL(pullRequest.url);
  };

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

        <View style={styles.editorCard}>
          <Text style={styles.fieldLabel}>Title</Text>
          <TextInput
            style={[styles.field, styles.inlineTitleInput]}
            value={draftTitle}
            onChangeText={setDraftTitle}
            placeholder="Task title"
            placeholderTextColor={colors.placeholder}
            multiline
          />
          {remoteDescription ? (
            <>
              <Text style={styles.fieldLabel}>{providerName} description</Text>
              <Text style={[styles.field, styles.remoteDescriptionText]}>
                {remoteDescription}
              </Text>
            </>
          ) : null}
          <Text style={styles.fieldLabel}>
            {remoteDescription ? "Notes" : "Description"}
          </Text>
          <TextInput
            style={[styles.field, styles.inlineBriefInput]}
            value={draftBrief}
            onChangeText={setDraftBrief}
            placeholder={
              remoteDescription
                ? "Local context and implementation notes…"
                : "Context, acceptance criteria, implementation notes…"
            }
            placeholderTextColor={colors.placeholder}
            multiline
          />
          <View style={styles.inlineSaveRow}>
            <Text style={styles.inlineSaveHint}>
              {canSaveEdit ? "Unsaved changes" : "Changes save to the task board."}
            </Text>
            <Pressable
              style={[styles.inlineSaveBtn, !canSaveEdit && styles.btnBusy]}
              disabled={!canSaveEdit}
              onPress={onApplyEdit}
            >
              {savingEdit ? (
                <ActivityIndicator color={colors.onPrimary} size="small" />
              ) : null}
              <Text style={styles.inlineSaveText}>
                {savingEdit ? "Saving…" : "Save"}
              </Text>
            </Pressable>
          </View>
        </View>

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

        <Text style={styles.sectionLabel}>Work item</Text>
        {task.remote_key ? (
          <View style={styles.workItemBox}>
            <Pressable
              style={styles.workItemMain}
              onPress={() => remoteUrl && Linking.openURL(remoteUrl)}
              disabled={!remoteUrl}
            >
              <View style={styles.workItemIcon}>
                <Text style={styles.workItemIconText}>
                  {(task.remote_provider || "R").slice(0, 2).toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.workItemKey} numberOfLines={1}>
                  {task.remote_key}
                  {task.remote_status_label
                    ? ` · ${task.remote_status_label}`
                    : ""}
                </Text>
                <Text style={styles.workItemSub} numberOfLines={2}>
                  {remoteUrl || `Linked ${providerName} item`}
                </Text>
              </View>
            </Pressable>
            <View style={styles.workItemActions}>
              {remoteUrl ? (
                <Pressable
                  style={styles.smallBtn}
                  onPress={() => Linking.openURL(remoteUrl)}
                >
                  <Text style={styles.smallBtnText}>Open</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={[styles.smallBtn, remoteBusy && styles.btnBusy]}
                onPress={refreshRemote}
                disabled={remoteBusy}
              >
                <Text style={styles.smallBtnText}>
                  {remoteBusy ? "Working…" : `Sync ${providerName}`}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            style={[styles.briefBox, styles.briefEmpty]}
            onPress={() => setRemoteLinkOpen(true)}
          >
            <Text style={styles.briefPlaceholder}>
              {remoteContext?.enabled
                ? `Tap to link a ${providerName} key/URL or owner/repo#number.`
                : "Remote work items are not enabled for this project on the Mac."}
            </Text>
          </Pressable>
        )}

        {openPullRequests.length > 0 ? (
          <>
            <Text style={styles.sectionLabel}>Pull Requests</Text>
            <View style={styles.pullRequestList}>
              {openPullRequests.map((pullRequest) => (
                <Pressable
                  key={pullRequest.url || `${pullRequest.label}:${pullRequest.number}`}
                  style={styles.pullRequestRow}
                  onPress={() => openPullRequest(pullRequest)}
                >
                  <View style={styles.pullRequestDot} />
                  <View style={styles.pullRequestText}>
                    <Text style={styles.pullRequestTitle} numberOfLines={1}>
                      {pullRequestCompactLabel(pullRequest)}
                    </Text>
                    <Text style={styles.pullRequestSub} numberOfLines={1}>
                      {pullRequestDetailLabel(pullRequest)}
                    </Text>
                  </View>
                  <Text style={styles.pullRequestOpen}>Open</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        <View style={styles.actions}>
          {task.workspace_id || taskWorkspaces.length > 0 ? (
            <>
              {taskWorkspaces.length > 0 ? (
                <View style={styles.agentWorkspaceList}>
                  {taskWorkspaces.map((workspace) => (
                    <Pressable
                      key={workspace.id}
                      style={styles.agentWorkspaceRow}
                      onPress={() => openWorkspace(workspace.id)}
                      disabled={opening}
                    >
                      <View style={styles.agentWorkspaceText}>
                        <Text style={styles.agentWorkspaceTitle} numberOfLines={1}>
                          {workspaceAgentTitle(workspace)}
                        </Text>
                        <Text style={styles.agentWorkspaceSub} numberOfLines={1}>
                          {workspaceAgentSubtitle(workspace)}
                        </Text>
                      </View>
                      {opening ? (
                        <ActivityIndicator color={colors.primary} size="small" />
                      ) : (
                        <Text style={styles.agentWorkspaceOpen}>Open</Text>
                      )}
                    </Pressable>
                  ))}
                </View>
              ) : task.workspace_id ? (
                <View style={styles.agentWorkspaceRow}>
                  <View style={styles.agentWorkspaceText}>
                    <Text style={styles.agentWorkspaceTitle} numberOfLines={1}>
                      Agent workspace closed
                    </Text>
                    <Text style={styles.agentWorkspaceSub} numberOfLines={1}>
                      {shortId(task.workspace_id)}
                    </Text>
                  </View>
                </View>
              ) : null}
            </>
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
          {canOpenChanges ? (
            <Pressable
              style={[styles.btn, styles.btnSecondary]}
              onPress={onOpenChanges}
            >
              <Text style={styles.btnSecondaryText}>
                {changeCount > 0
                  ? `View ${changeCount === 1 ? "1 change" : `${changeCount} changes`}`
                  : "View changes"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>

      <RemoteLinkSheet
        visible={remoteLinkOpen}
        initialValue={task.remote_url ?? task.remote_key ?? ""}
        busy={remoteBusy}
        onClose={() => {
          if (!remoteBusy) setRemoteLinkOpen(false);
        }}
        onApply={linkRemote}
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
        promptText={agentPromptText}
        onPromptTextChange={setAgentPromptText}
        planMode={agentPlanMode}
        onPlanModeChange={setAgentPlanMode}
        starting={starting}
      />
    </SafeAreaView>
  );
}

interface RemoteLinkSheetProps {
  visible: boolean;
  initialValue: string;
  busy: boolean;
  onClose: () => void;
  onApply: (input: string) => void;
}
function RemoteLinkSheet({
  visible,
  initialValue,
  busy,
  onClose,
  onApply,
}: RemoteLinkSheetProps) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  const trimmed = value.trim();
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
          <Text style={styles.sheetTitle}>Link work item</Text>
          <Text style={styles.sheetSub}>
            Paste a Jira key/URL, GitHub issue URL, or owner/repo#number.
          </Text>
          <Text style={styles.fieldLabel}>Remote item</Text>
          <TextInput
            style={styles.field}
            value={value}
            onChangeText={setValue}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="KAN-123 or owner/repo#42"
            placeholderTextColor={colors.placeholder}
          />
          <Pressable
            style={[
              styles.btn,
              styles.btnPrimary,
              { marginTop: 14 },
              (!trimmed || busy) && styles.btnBusy,
            ]}
            disabled={!trimmed || busy}
            onPress={() => onApply(trimmed)}
          >
            {busy ? (
              <ActivityIndicator color={colors.onPrimary} size="small" />
            ) : null}
            <Text style={styles.btnPrimaryText}>
              {busy ? "Linking…" : "Link work item"}
            </Text>
          </Pressable>
          <Pressable style={[styles.cancel, busy && styles.btnBusy]} onPress={onClose} disabled={busy}>
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
  onConfirm: (
    agentId: string | null,
    allowDirty: boolean,
    promptText: string,
    planMode: boolean
  ) => void;
  defaultAllowDirty: boolean;
  promptText: string;
  onPromptTextChange: (value: string) => void;
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
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
  promptText,
  onPromptTextChange,
  planMode,
  onPlanModeChange,
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
            Picks the terminal agent and the first prompt to send on the new worktree.
          </Text>
          <Text style={styles.fieldLabel}>Prompt</Text>
          <TextInput
            style={[styles.field, styles.promptField]}
            value={promptText}
            onChangeText={onPromptTextChange}
            placeholder="Tell the agent what to do for this task."
            placeholderTextColor={colors.placeholder}
            multiline
            textAlignVertical="top"
            editable={!starting}
          />
          <Pressable
            style={[styles.toggleRow, planMode && styles.toggleRowActive]}
            onPress={() => !starting && onPlanModeChange(!planMode)}
            disabled={starting}
          >
            <View style={[styles.checkbox, planMode && styles.checkboxActive]}>
              {planMode ? <Text style={styles.checkboxMark}>✓</Text> : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleTitle}>Plan mode</Text>
              <Text style={styles.toggleHint}>
                Ask the agent to plan first instead of editing immediately.
              </Text>
            </View>
          </Pressable>
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
            onPress={() => onConfirm(selectedId, allowDirty, promptText, planMode)}
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

function defaultTaskAgentPrompt(task: TaskRecord): string {
  const lines = [`Implement this task: ${task.title.trim()}`];
  const brief = task.brief?.trim();
  if (brief) {
    lines.push("", "Task details:", brief);
  }
  const remoteDescription = task.remote_description?.trim();
  if (remoteDescription) {
    lines.push("", "Remote description:", remoteDescription);
  }
  const remoteLabel = [task.remote_provider, task.remote_key]
    .filter(Boolean)
    .join(" ");
  if (remoteLabel || task.remote_url) {
    lines.push("", "Remote work item:");
    if (remoteLabel) lines.push(remoteLabel);
    if (task.remote_url) lines.push(task.remote_url);
  }
  lines.push("", "Work in the task worktree and make the minimal coherent change.");
  return lines.join("\n");
}

function taskMatchingWorkspaces(
  task: TaskRecord,
  workspaces: WorkspaceSummary[]
): WorkspaceSummary[] {
  const taskWorkspaceId = task.workspace_id?.trim();
  const taskPath = normalizedPath(task.worktree_path);
  return workspaces.filter((workspace) => {
    if (taskWorkspaceId && workspace.id === taskWorkspaceId) return true;
    if (!taskPath) return false;
    return [workspace.worktree_path, workspace.current_directory]
      .map(normalizedPath)
      .includes(taskPath);
  }).filter(workspaceIsAgent);
}

function normalizedPath(path?: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function workspaceAgentTitle(workspace: WorkspaceSummary): string {
  return (
    workspace.terminal_agent_id?.trim() ||
    workspace.agent?.trim() ||
    workspaceLabel(workspace)
  );
}

function workspaceAgentSubtitle(workspace: WorkspaceSummary): string {
  return (
    workspace.agent_activity_preview?.trim() ||
    workspace.branch?.trim() ||
    workspace.worktree_path?.trim() ||
    workspaceLabel(workspace)
  );
}

function workspaceIsAgent(workspace: WorkspaceSummary): boolean {
  return Boolean(
    workspace.terminal_agent_id ||
      workspace.agent ||
      workspace.agent_activity_phase ||
      workspace.agent_activity_updated_at
  );
}

function taskOpenPullRequests(task: TaskRecord): PullRequestSummary[] {
  return (task.pull_requests ?? []).filter((pullRequest) => {
    const status = pullRequest.status?.toLowerCase();
    return status === "open" || !status;
  });
}

function pullRequestCompactLabel(pullRequest: PullRequestSummary): string {
  return `${pullRequest.label || "PR"} #${pullRequest.number}`;
}

function pullRequestDetailLabel(pullRequest: PullRequestSummary): string {
  const status =
    pullRequest.display_status ||
    pullRequest.status_detail ||
    pullRequest.status ||
    "open";
  const base = pullRequest.base_branch ? ` -> ${pullRequest.base_branch}` : "";
  const stale = pullRequest.stale ? " · stale" : "";
  return `${status}${base}${stale}`;
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

  editorCard: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    padding: 12,
    marginBottom: 12,
  },
  inlineTitleInput: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "800",
    minHeight: 48,
  },
  inlineBriefInput: {
    minHeight: 108,
    textAlignVertical: "top",
    lineHeight: 19,
  },
  remoteDescriptionText: {
    color: colors.text,
    lineHeight: 19,
  },
  inlineSaveRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  inlineSaveHint: {
    flex: 1,
    color: colors.sub,
    fontSize: 11,
  },
  inlineSaveBtn: {
    minHeight: 34,
    minWidth: 74,
    paddingHorizontal: 12,
    borderRadius: radii.sm,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  inlineSaveText: {
    color: colors.onPrimary,
    fontSize: 12,
    fontWeight: "900",
  },

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
  briefPlaceholder: {
    color: colors.placeholder,
    fontSize: 13,
    fontStyle: "italic",
  },
  workItemBox: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    padding: 10,
    gap: 10,
  },
  workItemMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  workItemIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.primaryDim,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    alignItems: "center",
    justifyContent: "center",
  },
  workItemIconText: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: "900",
    fontFamily: monoFont,
  },
  workItemKey: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  workItemSub: {
    color: colors.sub,
    fontSize: 11,
    marginTop: 2,
  },
  workItemActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  smallBtn: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  smallBtnText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "800",
  },
  actions: { gap: 8, marginTop: 16 },
  pullRequestList: { gap: 8 },
  pullRequestRow: {
    minHeight: 52,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  pullRequestDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  pullRequestText: { flex: 1, minWidth: 0 },
  pullRequestTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  pullRequestSub: {
    color: colors.sub,
    fontSize: 11,
    marginTop: 2,
  },
  pullRequestOpen: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "800",
  },
  agentWorkspaceList: { gap: 8 },
  agentWorkspaceRow: {
    minHeight: 54,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  agentWorkspaceText: { flex: 1, minWidth: 0 },
  agentWorkspaceTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  agentWorkspaceSub: {
    color: colors.sub,
    fontSize: 11,
    fontFamily: monoFont,
    marginTop: 2,
  },
  agentWorkspaceOpen: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "800",
  },
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
  btnSecondary: {
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  btnSecondaryText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "800",
  },

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
  promptField: { minHeight: 128, maxHeight: 220, marginBottom: 12 },

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
