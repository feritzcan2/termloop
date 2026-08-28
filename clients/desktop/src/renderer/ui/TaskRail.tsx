import { Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDraggable, useDroppable, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";
import type { AgentGroupLayout } from "../../layout/model.js";
import { agentName, basename, canDismissTaskWorktreeProvisioning, isLiveSession, taskJiraIssueKey, type AgentStatus, type BranchCommitSummary, type GitHostProjection, type RunConfiguration, type RunRuntime, type Session, type Task, type TaskDeleteWorktreeResult, type TaskDeleteWorktreeReview } from "../model.js";
import { agentActivityIsOlder, agentActivityPriority, agentAttention, agentGroupActivityPriority, agentLastKnownActivityAtEpochMs, sessionState } from "../session-presentation.js";
import { integrationTone, taskChangeCount, taskChangeLabel, taskChangedFileLabel, taskDivergence, taskIntegration, taskPrimaryAction, taskRowAccessibleName, taskRowTone, taskStage, type TaskDivergence, type TaskIntegration, type TaskNextStepKind, type TaskSignalTone, type TaskStage } from "../task-presentation.js";
import { Icon } from "./Icon.js";
import { OverlayPortal } from "./OverlayPortal.js";
import { AskToHelperRow, MenuButton, SessionRowButton, SessionRowClose, sessionRelationshipLabel } from "./SessionRow.js";
import { BindBranchDialog } from "./task-dialogs/bind-branch-dialog.js";
import { ProvisionWorktreeDialog } from "./task-dialogs/provision-worktree-dialog.js";
import { CleanupWorktreeDialog } from "./task-dialogs/cleanup-worktree-dialog.js";
import { DeleteTaskDialog } from "./task-dialogs/delete-task-dialog.js";
import { RepairWorktreeDialog } from "./task-dialogs/repair-worktree-dialog.js";
import { TaskEditor, type EditorState, type TaskCreateOutcome, type TaskStartSelection } from "./task-dialogs/task-editor.js";
import type { AgentCapabilityDto, ProjectLocalBranchListResult, ProjectTaskAutomationGetResult, RunConfigurationCreateParams, RunConfigurationDto, RunConfigurationImproverTarget, RunConfigurationUpdateParams, TaskArchivePreviewDto, TaskCleanupWorktreeParams, TaskProvisionWorktreeParams, TaskRepairWorktreeParams, TaskWorktreeCleanupPreviewDto, TaskWorktreeRepairPreviewDto } from "@termloop/contract/current";
import { pullRequestIdentity, type ChangesOpenSource } from "../change-source.js";
import { isAssistantSession } from "./AssistantRail.js";
import { isProjectRelocationDragCandidate, isTaskRelocationDragCandidate, useOptionalSidebarSessionDnd, type SessionDropPlacement } from "./SidebarSessionDnd.js";
import { readWorktreeParentPath, writeWorktreeParentPath } from "../worktree-parent-memory.js";
import { readTaskCollapsed, writeTaskCollapsed } from "../task-collapse-memory.js";
import { readTaskTabSelection, writeTaskTabSelection, type TaskTabStatus } from "../task-tab-memory.js";
import { readFavoriteTaskIds, writeFavoriteTaskIds } from "../task-favorite-memory.js";
import { AgentPlanDisclosure } from "./AgentPlanDisclosure.js";
import { RunSessionLine, TaskRunLaunchers, runCommandsBySessionId, runtimesBySessionId } from "./TaskRuns.js";
import type { RunImprovement } from "./TaskRuns.js";
import { AgentGroupFrame, agentSessionClusterMembers, agentSessionClusters, type AgentSessionCluster } from "./AgentGroup.js";

type MenuState = { taskId: string; x: number; y: number; invoker: HTMLElement };
type TaskListTab = TaskTabStatus;
let taskRowRenderCount = 0;

function rememberedTaskTabs(projectId: string | undefined): Partial<Record<TaskListTab, string>> {
  const active = readTaskTabSelection(projectId, "active");
  const closed = readTaskTabSelection(projectId, "closed");
  return { ...(active ? { active } : {}), ...(closed ? { closed } : {}) };
}

export function taskRowRenders(): number {
  return taskRowRenderCount;
}

/// Sessions are Project-scoped; grouping them under a Task is a read-only
/// projection, never a stored link. Live containment comes from core's presence
/// projection. A stopped descriptor retains only its original canonical cwd,
/// so it stays with the Task only when that cwd exactly equals the current
/// worktree root.
export function taskAttachedSessionIds(
  tasks: readonly Task[],
  sessionsById: ReadonlyMap<string, Session>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    for (const attached of task.worktree_presence?.attached_sessions ?? []) {
      const session = sessionsById.get(attached.session_id);
      if (session && !isAssistantSession(session)) ids.add(attached.session_id);
    }
    const worktreePath = task.worktree?.path;
    if (!worktreePath) continue;
    for (const session of sessionsById.values()) {
      if (session.process.cwd === worktreePath
        && !isAssistantSession(session)) ids.add(session.id);
    }
  }
  return ids;
}

/// A Session's own Task is never a relocation target: it already lives inside
/// that worktree, so the group must not light up or accept the drop for it.
export function taskRelocationDropEnabled(
  task: Task,
  sessionsById: ReadonlyMap<string, Session>,
  deleting: boolean,
  draggedSession: Session | undefined,
): boolean {
  return task.status === "open"
    && task.archived_at_epoch_ms === null
    && !deleting
    && draggedSession !== undefined
    && isTaskRelocationDragCandidate(draggedSession)
    && !taskAttachedSessionIds([task], sessionsById).has(draggedSession.id);
}

/// The Sessions a Task shows: the ones running in its checkout, plus the Ask-To
/// helpers those Sessions launched. Shared with the Task detail page so both
/// surfaces answer "who is working on this Task" the same way.
export function taskSessions(task: Task, sessionsById: ReadonlyMap<string, Session>): Session[] {
  const ids = taskAttachedSessionIds([task], sessionsById);
  const nestedHelpers = askToHelpersForSources(ids, sessionsById);
  const presentationIds = new Set([...ids, ...nestedHelpers]);
  return [...presentationIds].flatMap((sessionId) => {
    const session = sessionsById.get(sessionId);
    return session ? [session] : [];
  });
}

function liveAgentMembers(group: AgentSessionCluster): Session[] {
  return agentSessionClusterMembers(group).filter(
    (session) => session.kind === "Agent" && isLiveSession(session),
  );
}

function taskGroupHasOlderActivity(
  group: AgentSessionCluster,
  statusesById: ReadonlyMap<string, AgentStatus>,
  reviewReadySessionIds: ReadonlySet<string>,
  nowEpochMs: number,
): boolean {
  const members = liveAgentMembers(group);
  return members.length > 0
    && agentGroupActivityPriority(members, statusesById, reviewReadySessionIds) >= 4
    && members.every((session) => agentActivityIsOlder(session, statusesById.get(session.id), nowEpochMs));
}

/// Task rows keep terminals and stopped context in their existing slots while
/// live Agent groups follow the same activity order as All Active Agents.
/// Ask-To helpers move with their exact source and contribute their loudest
/// state to the aggregate group priority.
function taskSessionGroupsByActivity(
  sessions: readonly Session[],
  statusesById: ReadonlyMap<string, AgentStatus>,
  reviewReadySessionIds: ReadonlySet<string>,
  nowEpochMs: number,
  manualGroups: readonly AgentGroupLayout[],
  detachedRelationshipSessionIds: ReadonlySet<string>,
): AgentSessionCluster[] {
  const groups = agentSessionClusters(sessions, manualGroups, detachedRelationshipSessionIds);
  const activeGroups = groups.filter((group) => liveAgentMembers(group).length > 0);
  const priority = (group: AgentSessionCluster) => agentGroupActivityPriority(
    liveAgentMembers(group),
    statusesById,
    reviewReadySessionIds,
  );
  const latestObservation = (group: AgentSessionCluster) => Math.max(...liveAgentMembers(group).map(
    (session) => agentLastKnownActivityAtEpochMs(statusesById.get(session.id)),
  ));
  activeGroups.sort((left, right) => {
    const leftPriority = priority(left);
    const rightPriority = priority(right);
    const priorityDifference = leftPriority - rightPriority;
    if (priorityDifference !== 0) return priorityDifference;
    const ageDifference = Number(taskGroupHasOlderActivity(left, statusesById, reviewReadySessionIds, nowEpochMs))
      - Number(taskGroupHasOlderActivity(right, statusesById, reviewReadySessionIds, nowEpochMs));
    if (ageDifference !== 0) return ageDifference;
    return latestObservation(right) - latestObservation(left);
  });

  let activeIndex = 0;
  return groups.map((group) => liveAgentMembers(group).length > 0
    ? activeGroups[activeIndex++]!
    : group);
}

/// Favorites form the leading group. Within favorite and ordinary groups, live
/// work floats loudest-first using the same activity ranking as the row's agent
/// dots. Equal entries retain their durable order.
export function openTasksByActivity(
  tasks: readonly Task[],
  sessionsById: ReadonlyMap<string, Session>,
  statusesById: ReadonlyMap<string, AgentStatus>,
  reviewReadySessionIds: ReadonlySet<string>,
  favoriteTaskIds: ReadonlySet<string> = new Set(),
): Task[] {
  const quiet = Number.MAX_SAFE_INTEGER;
  const priority = (task: Task): number => {
    const liveAgents = taskSessions(task, sessionsById)
      .filter((session) => session.kind === "Agent" && isLiveSession(session));
    return liveAgents.length === 0
      ? quiet
      : agentGroupActivityPriority(liveAgents, statusesById, reviewReadySessionIds);
  };
  return tasks
    .map((task, index) => ({ task, index, priority: priority(task), favorite: favoriteTaskIds.has(task.id) }))
    .sort((left, right) => left.favorite !== right.favorite
      ? left.favorite ? -1 : 1
      : left.priority === right.priority
        ? left.index - right.index
        : left.priority - right.priority)
    .map((entry) => entry.task);
}

/// Helper nesting is an independent exact source-Session projection. It does
/// not make the helper Task-attached or place it under Task lifecycle authority.
export function askToHelpersForSources(
  sourceIds: ReadonlySet<string>,
  sessionsById: ReadonlyMap<string, Session>,
): ReadonlySet<string> {
  const helpers = new Set<string>();
  for (const session of sessionsById.values()) {
    const sourceId = session.ask_to_source_session_id ?? session.fork_source_session_id;
    const source = sourceId ? sessionsById.get(sourceId) : undefined;
    if (session.kind === "Agent"
      && source?.kind === "Agent"
      && sourceIds.has(source.id)
      && (session.ask_to_source_session_id === source.id || session.fork_source_session_id === source.id)) {
      helpers.add(session.id);
    }
  }
  return helpers;
}

export type TaskRailProps = {
  projectId: string | undefined;
  projectFolder: string | undefined;
  tasks: readonly Task[];
  gitHostProjections: readonly GitHostProjection[];
  branchCommitSummaries: readonly BranchCommitSummary[];
  runConfigurations: readonly RunConfiguration[];
  runRuntimes: readonly RunRuntime[];
  runStateRevision: number;
  sessionsById: ReadonlyMap<string, Session>;
  agentGroups?: readonly AgentGroupLayout[] | undefined;
  detachedRelationshipSessionIds?: ReadonlySet<string> | undefined;
  detachRelationship?: ((sessionId: string) => void) | undefined;
  renameAgentGroup?: ((sessionId: string, name: string) => void) | undefined;
  ungroupAgentGroup?: ((sessionId: string) => void) | undefined;
  statusesById: ReadonlyMap<string, AgentStatus>;
  reviewReadySessionIds: ReadonlySet<string>;
  selectedSessionId: string | undefined;
  visibleSessionIds: ReadonlySet<string>;
  menuSessionId: string | undefined;
  deletingTaskIds: ReadonlySet<string>;
  provisioningTaskIds?: ReadonlySet<string> | undefined;
  selectSession(sessionId: string): void;
  openSessionMenu(sessionId: string, x: number, y: number, invoker: HTMLElement): void;
  dismissSession(sessionId: string): void;
  resumeSession(sessionId: string): void;
  disabled: boolean;
  createTask(title: string, brief: string | null): Promise<TaskCreateOutcome>;
  updateTask(taskId: string, title: string, brief: string | null): Promise<string | undefined>;
  bindTaskBranch(taskId: string, repositoryPath: string, branchName: string): Promise<string | undefined>;
  listProjectLocalBranches(projectId: string): Promise<ProjectLocalBranchListResult>;
  loadProjectTaskAutomation?(projectId: string): Promise<ProjectTaskAutomationGetResult>;
  provisionTaskWorktree(params: TaskProvisionWorktreeParams): Promise<string | undefined>;
  dismissTaskWorktreeProvisioning(taskId: string, operationId: string): Promise<string | undefined>;
  inspectTaskWorktreeCleanup(taskId: string): Promise<TaskWorktreeCleanupPreviewDto>;
  cleanupTaskWorktree(params: TaskCleanupWorktreeParams): Promise<string | undefined>;
  openTaskChanges(taskId: string, source: ChangesOpenSource): void;
  /// Clicking a Task row puts it on the stage. The rail only raises the intent;
  /// the Shell owns which surface the stage is showing.
  openTaskDetail(taskId: string): void;
  detailTaskId: string | undefined;
  agentCapabilities: readonly AgentCapabilityDto[];
  launchTaskTerminal(taskId: string): Promise<string | undefined>;
  launchTaskAgent(taskId: string, agentId: string, model?: string, permission?: AgentCapabilityDto["permissions"][number], reasoning?: AgentCapabilityDto["reasoning"][number], kickoffMessage?: string): Promise<string | undefined>;
  runImprovement: RunImprovement;
  setupRunImprovement(projectId: string, target: RunConfigurationImproverTarget): void;
  saveRunConfiguration(params: RunConfigurationCreateParams | RunConfigurationUpdateParams): Promise<RunConfigurationDto | string>;
  deleteRunConfiguration(configurationId: string): Promise<string | undefined>;
  launchTaskRun(taskId: string, configurationId: string, restart: boolean, forceSetup?: boolean): Promise<string | undefined>;
  inspectTaskWorktreeRepair(taskId: string, candidatePath: string): Promise<TaskWorktreeRepairPreviewDto>;
  repairTaskWorktree(params: TaskRepairWorktreeParams): Promise<string | undefined>;
  dismissTaskWorktreeRepair(taskId: string, operationId: string): Promise<string | undefined>;
  setTaskClosed(taskId: string, closed: boolean): Promise<void>;
  inspectTaskArchive(taskId: string): Promise<TaskArchivePreviewDto>;
  archiveTask(taskId: string, archiveTicket: string): Promise<string | undefined>;
  /// Archive is initiated here but archived Tasks are rendered by the dedicated
  /// Archived section, so this rail reports the count for its header breadcrumb
  /// and announces a successful archive rather than owning the archived list.
  archivedTaskCount: number;
  archivedTasksChanged(): void;
  deleteTaskAndWorktree(taskId: string, review?: TaskDeleteWorktreeReview): Promise<TaskDeleteWorktreeResult>;
  openExternal(url: string, runSessionId?: string): Promise<void>;
  provisionRequestedTaskId?: string | undefined;
  provisionRequestHandled?(): void;
  /// The Create Task action lives in the Shell's tab bar now that this rail has
  /// no title row; the Shell raises the request and this rail opens its editor.
  createRequested?: boolean | undefined;
  createRequestHandled?(): void;
  overlayVisibilityChanged(visible: boolean): void;
  overlayContainer: Element | undefined;
  nowEpochMs?: number | undefined;
};

export function TaskRail(props: TaskRailProps) {
  const [selectedTab, setSelectedTab] = useState<TaskListTab>("active");
  const [selectedTaskIds, setSelectedTaskIds] = useState<Partial<Record<TaskListTab, string>>>(() => rememberedTaskTabs(props.projectId));
  const [favoriteTaskIds, setFavoriteTaskIds] = useState<ReadonlySet<string>>(() => readFavoriteTaskIds(props.projectId));
  const [renamingTaskTab, setRenamingTaskTab] = useState<{ taskId: string; title: string; busy: boolean; error: string | undefined }>();
  const [closingTaskTab, setClosingTaskTab] = useState<{ taskId: string; busy: boolean }>();
  const taskListId = useId();
  const taskTabsRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<EditorState>();
  const [menu, setMenu] = useState<MenuState>();
  const [clockNowEpochMs, setClockNowEpochMs] = useState(Date.now);
  useEffect(() => {
    if (props.nowEpochMs !== undefined) return;
    const handle = window.setInterval(() => setClockNowEpochMs(Date.now()), 60_000);
    return () => window.clearInterval(handle);
  }, [props.nowEpochMs]);
  const nowEpochMs = props.nowEpochMs ?? clockNowEpochMs;
  const [deleteTarget, setDeleteTarget] = useState<Task>();
  const [bindTarget, setBindTarget] = useState<Task>();
  const [provisionTarget, setProvisionTarget] = useState<Task>();
  /// Seeded from the per-Project client-local memory so the suggestion
  /// survives app restarts; every write refreshes both the state and the store.
  const [lastWorktreeParentPath, setLastWorktreeParentPath] = useState<string | undefined>(
    () => readWorktreeParentPath(props.projectId),
  );
  useEffect(() => {
    setLastWorktreeParentPath(readWorktreeParentPath(props.projectId));
  }, [props.projectId]);
  const rememberParentPath = useCallback((parentPath: string) => {
    setLastWorktreeParentPath(parentPath);
    writeWorktreeParentPath(props.projectId, parentPath);
  }, [props.projectId]);
  const [cleanupTarget, setCleanupTarget] = useState<Task>();
  const [repairTarget, setRepairTarget] = useState<Task>();
  const [archiveTarget, setArchiveTarget] = useState<Task>();
  /// Launches the create flow requested for a Task whose worktree is still
  /// provisioning. Client-local intent only — nothing here is durable, and a
  /// Task that lands anywhere other than launch-ready silently drops its entry
  /// so the row's ordinary failure surface stays the single authority.
  const [pendingLaunches, setPendingLaunches] = useState<ReadonlyMap<string, readonly TaskStartSelection[]>>(new Map());
  const firedLaunchesRef = useRef(new Set<string>());
  const taskMenuRef = useRef<HTMLDivElement>(null);
  const gitHostByTask = useMemo(
    () => new Map(props.gitHostProjections.map((projection) => [projection.task_id, projection])),
    [props.gitHostProjections],
  );
  const branchCommitsByTask = useMemo(
    () => new Map(props.branchCommitSummaries.map((summary) => [summary.task_id, summary])),
    [props.branchCommitSummaries],
  );
  const openTasks = openTasksByActivity(
    props.tasks.filter((task) => task.status === "open"),
    props.sessionsById,
    props.statusesById,
    props.reviewReadySessionIds,
    favoriteTaskIds,
  );
  const closedTasks = props.tasks.filter((task) => task.status === "closed");
  const taskTabPresentationById = useMemo(() => new Map(props.tasks.map((task) => {
    const sessions = taskSessions(task, props.sessionsById);
    const attention = agentAttention(sessions, props.statusesById, props.reviewReadySessionIds);
    const stage = taskStage(task, props.deletingTaskIds.has(task.id), props.provisioningTaskIds?.has(task.id));
    return [task.id, {
      attention,
      tone: taskRowTone(stage, attention),
      liveAgentCount: sessions.filter((session) => session.kind === "Agent" && isLiveSession(session)).length,
    }] as const;
  })), [props.tasks, props.sessionsById, props.statusesById, props.reviewReadySessionIds, props.deletingTaskIds, props.provisioningTaskIds]);
  const menuTask = menu ? props.tasks.find((task) => task.id === menu.taskId) : undefined;
  const currentDeleteTarget = deleteTarget
    ? props.tasks.find((task) => task.id === deleteTarget.id) ?? deleteTarget
    : undefined;
  const overlayVisible = Boolean(
    menu || editor || currentDeleteTarget || bindTarget || provisionTarget || cleanupTarget ||
    repairTarget || archiveTarget,
  );
  const renderTask = (task: Task, focused = false) => (
    <TaskGroup
      key={`${props.projectId ?? "unknown"}:${task.id}`}
      projectId={props.projectId}
      task={task}
      gitHostProjection={gitHostByTask.get(task.id)}
      branchCommitSummary={branchCommitsByTask.get(task.id)}
      runConfigurations={props.runConfigurations}
      runRuntimes={props.runRuntimes}
      runStateRevision={props.runStateRevision}
      openExternal={props.openExternal}
      sessionsById={props.sessionsById}
      agentGroups={props.agentGroups}
      detachedRelationshipSessionIds={props.detachedRelationshipSessionIds}
      detachRelationship={props.detachRelationship}
      renameAgentGroup={props.renameAgentGroup}
      ungroupAgentGroup={props.ungroupAgentGroup}
      statusesById={props.statusesById}
      reviewReadySessionIds={props.reviewReadySessionIds}
      selectedSessionId={props.selectedSessionId}
      visibleSessionIds={props.visibleSessionIds}
      menuSessionId={props.menuSessionId}
      selectSession={props.selectSession}
      openSessionMenu={props.openSessionMenu}
      dismissSession={props.dismissSession}
      resumeSession={props.resumeSession}
      openMenu={openMenu}
      createWorktree={setProvisionTarget}
      inspectRepair={setRepairTarget}
      agentCapabilities={props.agentCapabilities}
      launchTerminal={props.launchTaskTerminal}
      launchAgent={props.launchTaskAgent}
      runImprovement={props.runImprovement}
      setupRunImprovement={props.setupRunImprovement}
      saveRunConfiguration={props.saveRunConfiguration}
      deleteRunConfiguration={props.deleteRunConfiguration}
      launchTaskRun={props.launchTaskRun}
      overlayContainer={props.overlayContainer}
      overlayVisibilityChanged={props.overlayVisibilityChanged}
      openChanges={props.openTaskChanges}
      openDetail={props.openTaskDetail}
      detailOpen={props.detailTaskId === task.id}
      deleting={props.deletingTaskIds.has(task.id)}
      provisioning={props.provisioningTaskIds?.has(task.id) ?? false}
      nowEpochMs={nowEpochMs}
      focused={focused}
    />
  );

  useEffect(() => {
    setSelectedTab("active");
    setSelectedTaskIds(rememberedTaskTabs(props.projectId));
    setFavoriteTaskIds(readFavoriteTaskIds(props.projectId));
    setRenamingTaskTab(undefined);
    setClosingTaskTab(undefined);
    setEditor(undefined);
    setMenu(undefined);
    setDeleteTarget(undefined);
    setBindTarget(undefined);
    setProvisionTarget(undefined);
    setCleanupTarget(undefined);
    setRepairTarget(undefined);
    setArchiveTarget(undefined);
    setPendingLaunches(new Map());
  }, [props.projectId]);
  useEffect(() => {
    if (!closingTaskTab || props.tasks.some((task) => task.id === closingTaskTab.taskId && task.status === "open")) return;
    setClosingTaskTab(undefined);
  }, [closingTaskTab, props.tasks]);
  useEffect(() => {
    if (pendingLaunches.size === 0) return;
    const settled: string[] = [];
    for (const [taskId, starts] of pendingLaunches) {
      const task = props.tasks.find((candidate) => candidate.id === taskId);
      const stage = task ? taskStage(task, props.deletingTaskIds.has(taskId), props.provisioningTaskIds?.has(taskId)) : undefined;
      /// Still on its way to ready — or not yet visible in this projection —
      /// keep waiting for the next one. Entries clear on Project switch.
      if (!stage || stage.id === "provisioning" || stage.id === "planning" || stage.id === "branchOnly" || stage.id === "observing") continue;
      if (stage?.id === "ready" && !firedLaunchesRef.current.has(taskId)) {
        firedLaunchesRef.current.add(taskId);
        void (async () => {
          for (const start of starts) {
            if (start === "terminal") await props.launchTaskTerminal(taskId);
            else await props.launchTaskAgent(
              taskId,
              start.agentId,
              start.model,
              start.permission,
              start.reasoning,
              start.kickoffMessage ?? undefined,
            );
          }
        })();
      }
      settled.push(taskId);
    }
    if (settled.length === 0) return;
    setPendingLaunches((current) => {
      const next = new Map(current);
      for (const taskId of settled) next.delete(taskId);
      return next;
    });
  }, [pendingLaunches, props.tasks, props.deletingTaskIds, props.launchTaskTerminal, props.launchTaskAgent]);
  useEffect(() => {
    if (!props.provisionRequestedTaskId) return;
    const task = props.tasks.find((candidate) => candidate.id === props.provisionRequestedTaskId);
    if (!task) return;
    if (!task.worktree) setProvisionTarget(task);
    props.provisionRequestHandled?.();
  }, [props.provisionRequestHandled, props.provisionRequestedTaskId, props.tasks]);
  useEffect(() => {
    if (!props.createRequested) return;
    setEditor({ mode: "create" });
    props.createRequestHandled?.();
  }, [props.createRequestHandled, props.createRequested]);
  useEffect(() => { if (menu && !menuTask) setMenu(undefined); }, [menu, menuTask]);
  useEffect(() => {
    props.overlayVisibilityChanged(overlayVisible);
    return () => props.overlayVisibilityChanged(false);
  }, [overlayVisible, props.overlayVisibilityChanged]);
  useEffect(() => {
    if (!menu) return;
    requestAnimationFrame(() => taskMenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus());
  }, [menu]);

  const openMenu = useCallback((task: Task, x: number, y: number, invoker: HTMLElement) =>
    setMenu({ taskId: task.id, x, y, invoker }), []);
  const setEditTask = useCallback((task: Task) => setEditor({ mode: "edit", task }), []);
  const queueLaunches = useCallback((taskId: string, starts: readonly TaskStartSelection[]) => {
    if (starts.length === 0) return;
    setPendingLaunches((current) => new Map(current).set(taskId, starts));
  }, []);
  const closeMenu = () => {
    const invoker = menu?.invoker;
    setMenu(undefined);
    if (invoker) requestAnimationFrame(() => invoker.focus());
  };
  const perform = (action: () => unknown | Promise<unknown>) => {
    closeMenu();
    void action();
  };
  const selectAdjacentTab = (event: KeyboardEvent<HTMLButtonElement>, tab: TaskListTab) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSelectedTab(tab);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-task-list-tab="${tab}"]`)
      ?.focus();
  };
  const selectedTask = openTasks.find((task) => task.id === selectedTaskIds.active) ?? openTasks[0];
  const selectTask = useCallback((status: TaskListTab, taskId: string) => {
    setSelectedTaskIds((current) => ({ ...current, [status]: taskId }));
    writeTaskTabSelection(props.projectId, status, taskId);
  }, [props.projectId]);
  const toggleTaskFavorite = useCallback((taskId: string) => {
    setFavoriteTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      writeFavoriteTaskIds(props.projectId, next);
      return next;
    });
  }, [props.projectId]);
  const confirmTaskTabClose = async (taskId: string) => {
    if (closingTaskTab?.taskId !== taskId || closingTaskTab.busy) return;
    setClosingTaskTab({ taskId, busy: true });
    await props.setTaskClosed(taskId, true);
    setClosingTaskTab((current) => current?.taskId === taskId ? undefined : current);
  };
  const commitTaskTabRename = async (task: Task) => {
    if (!renamingTaskTab || renamingTaskTab.taskId !== task.id || renamingTaskTab.busy) return;
    const title = renamingTaskTab.title.trim();
    if (!title || title === task.title) {
      setRenamingTaskTab(undefined);
      return;
    }
    setRenamingTaskTab((current) => current?.taskId === task.id ? { ...current, busy: true, error: undefined } : current);
    const failure = await props.updateTask(task.id, title, task.brief);
    if (failure) {
      setRenamingTaskTab((current) => current?.taskId === task.id ? { ...current, busy: false, error: failure } : current);
    } else {
      setRenamingTaskTab(undefined);
    }
  };
  useEffect(() => {
    if (!selectedTask || selectedTaskIds.active === selectedTask.id) return;
    selectTask("active", selectedTask.id);
  }, [selectTask, selectedTask, selectedTaskIds.active]);
  useEffect(() => {
    taskTabsRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedTask?.id]);
  const selectTaskByKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft") nextIndex = index === 0 ? openTasks.length - 1 : index - 1;
    if (event.key === "ArrowRight") nextIndex = index === openTasks.length - 1 ? 0 : index + 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = openTasks.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = openTasks[nextIndex];
    if (!next) return;
    selectTask("active", next.id);
    taskTabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  };

  return (
    <section className="rail-section task-section" aria-label="Project Tasks">
      <div className="task-list-tabs" role="tablist" aria-label="Task status">
        <button type="button" role="tab" data-task-list-tab="active" aria-selected={selectedTab === "active"} aria-controls={taskListId} tabIndex={selectedTab === "active" ? 0 : -1} className={selectedTab === "active" ? "selected" : undefined} onKeyDown={(event) => selectAdjacentTab(event, "closed")} onClick={() => setSelectedTab("active")}>Active</button>
        <button type="button" role="tab" data-task-list-tab="closed" aria-selected={selectedTab === "closed"} aria-controls={taskListId} tabIndex={selectedTab === "closed" ? 0 : -1} className={selectedTab === "closed" ? "selected" : undefined} onKeyDown={(event) => selectAdjacentTab(event, "active")} onClick={() => setSelectedTab("closed")}>Closed</button>
      </div>
        <div id={taskListId} className="task-status-panel" role="tabpanel" aria-label={`${selectedTab === "active" ? "Active" : "Closed"} Tasks`}>
          {selectedTab === "active" && openTasks.length > 0 ? (
            <div className="task-item-tab-bar">
              <button type="button" className="task-tab-create" aria-label="Create Task" title="Create Task" disabled={props.disabled} onClick={() => setEditor({ mode: "create" })}><Icon name="add" /></button>
              <div ref={taskTabsRef} className="task-item-tabs" role="tablist" aria-label="Active Task selection">
                {openTasks.map((task, index) => {
                const selected = task.id === selectedTask?.id;
                const favorite = favoriteTaskIds.has(task.id);
                const renaming = renamingTaskTab?.taskId === task.id;
                const closing = closingTaskTab?.taskId === task.id;
                const presentation = taskTabPresentationById.get(task.id);
                const state = presentation?.attention?.label ?? (presentation?.liveAgentCount ? `${presentation.liveAgentCount} live ${presentation.liveAgentCount === 1 ? "agent" : "agents"}` : undefined);
                return <div key={task.id} className={`task-item-tab${selected ? " selected" : ""}${favorite ? " favorited" : ""}`} data-tone={presentation?.tone}>
                  {renaming ? <input
                    autoFocus
                    id={`${taskListId}-task-${index}`}
                    className="task-item-tab-rename"
                    data-task-tab-id={task.id}
                    value={renamingTaskTab.title}
                    maxLength={160}
                    disabled={renamingTaskTab.busy}
                    aria-label={`Rename ${task.title}`}
                    aria-invalid={Boolean(renamingTaskTab.error)}
                    title={renamingTaskTab.error ?? "Enter to save · Escape to cancel"}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setRenamingTaskTab((current) => current?.taskId === task.id ? { ...current, title: event.target.value, error: undefined } : current)}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={() => { void commitTaskTabRename(task); }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setRenamingTaskTab(undefined);
                      }
                    }}
                  /> : <button
                    type="button"
                    role="tab"
                    id={`${taskListId}-task-${index}`}
                    aria-controls={`${taskListId}-selected-task`}
                    data-task-tab-id={task.id}
                    data-tone={presentation?.tone}
                    aria-selected={selected}
                    aria-label={`${task.title}${state ? `, ${state}` : ""}`}
                    title={`${task.title}${state ? ` · ${state}` : ""}`}
                    tabIndex={selected ? 0 : -1}
                    className="task-item-tab-select"
                    onKeyDown={(event) => selectTaskByKeyboard(event, index)}
                    onContextMenu={(event) => { event.preventDefault(); openMenu(task, event.clientX, event.clientY, event.currentTarget); }}
                    onClick={() => selectTask("active", task.id)}
                    onDoubleClick={(event) => { event.preventDefault(); selectTask("active", task.id); setRenamingTaskTab({ taskId: task.id, title: task.title, busy: false, error: undefined }); }}
                  ><i className={`task-tab-dot ${presentation?.tone ?? "quiet"}`} aria-hidden="true" /><span>{task.title}</span>{presentation?.attention?.tone === "attention" ? <i className="task-tab-attention" aria-hidden="true" /> : null}</button>
                  }
                  {closing ? <div className="task-item-tab-close-confirm" role="group" aria-label={`Close ${task.title}?`} onKeyDown={(event) => {
                    if (event.key !== "Escape" || closingTaskTab.busy) return;
                    event.preventDefault();
                    setClosingTaskTab(undefined);
                  }}>
                    <span>Sure?</span>
                    <button type="button" autoFocus aria-label={`Confirm close ${task.title}`} disabled={closingTaskTab.busy} onClick={() => { void confirmTaskTabClose(task.id); }}>{closingTaskTab.busy ? "…" : "Yes"}</button>
                    <button type="button" aria-label={`Cancel close ${task.title}`} disabled={closingTaskTab.busy} onClick={() => setClosingTaskTab(undefined)}>No</button>
                  </div> : <>
                    <button type="button" className="task-item-tab-favorite" aria-label={`${favorite ? "Unfavorite" : "Favorite"} ${task.title}`} aria-pressed={favorite} title={favorite ? "Remove from favorites" : "Favorite Task"} onClick={() => toggleTaskFavorite(task.id)}><Icon name="star" /></button>
                    <button type="button" className="task-item-tab-close" aria-label={`Close ${task.title}`} title="Close Task" disabled={props.disabled || props.deletingTaskIds.has(task.id)} onClick={() => setClosingTaskTab({ taskId: task.id, busy: false })}><Icon name="close" /></button>
                  </>}
                </div>;
              })}
              </div>
            </div>
          ) : null}
          <div id={`${taskListId}-selected-task`} role={selectedTab === "active" ? "tabpanel" : undefined} aria-labelledby={selectedTab === "active" && selectedTask ? `${taskListId}-task-${openTasks.indexOf(selectedTask)}` : undefined}>
          <div className="task-list" role="list" aria-label={`${selectedTab === "active" ? "Active" : "Closed"} Tasks`}>
          {selectedTab === "active" && selectedTask ? renderTask(selectedTask, true) : null}
          {selectedTab === "closed" ? closedTasks.map((task) => renderTask(task)) : null}
          {/* A first-ever visitor gets the one-sentence model and the primary
              action; anyone with existing closed or archived Tasks already
              knows it and gets the quiet line back. */}
          {selectedTab === "active" && openTasks.length === 0 ? (
            props.tasks.length === 0 && props.archivedTaskCount === 0 ? (
              <div className="task-empty">
                <p className="task-empty-copy">A Task is one piece of work with its own Git checkout — a worktree. Terminals and agents you start inside it stay grouped under it.</p>
                <button type="button" className="task-empty-create" disabled={props.disabled} onClick={() => setEditor({ mode: "create" })}><Icon name="add" />Create your first Task</button>
                <p className="task-empty-hint">Just exploring? The buttons above open a Terminal, Claude, or Codex in the Project folder without a Task.</p>
              </div>
            ) : <p className="rail-empty">No active Tasks. Create one to start.</p>
          ) : null}
          {selectedTab === "closed" && closedTasks.length === 0 ? <p className="rail-empty">No closed Tasks.</p> : null}
          </div>
          </div>
        </div>
      <OverlayPortal container={props.overlayContainer}>
      {menu && menuTask && !props.deletingTaskIds.has(menuTask.id) ? (
        <div className="context-menu-layer" onKeyDown={(event) => { if (event.key === "Escape") closeMenu(); }}>
          <button className="context-menu-backdrop" aria-label="Close Task menu" onClick={closeMenu} />
          <div ref={taskMenuRef} className="context-menu task-context-menu" role="menu" aria-label={`${menuTask.title} actions`} style={{ left: Math.min(menu.x, window.innerWidth - 238), top: Math.min(menu.y, window.innerHeight - 190) }}>
            <header><strong>{menuTask.title}</strong><span>{menuTask.worktree ? menuTask.worktree.path : "No worktree yet"}</span></header>
            <MenuButton icon="edit" label="Edit Task" detail="Title and brief" action={() => perform(() => setEditTask(menuTask))} />
            {!menuTask.branch ? <MenuButton icon="branch" label="Use existing branch" detail="Link a local branch to this Task" action={() => perform(() => setBindTarget(menuTask))} /> : null}
            {!menuTask.worktree ? <MenuButton icon="terminal" label="Create worktree" detail={menuTask.worktree_provisioning?.status === "failed" ? "Retry with reviewed values" : "A separate checkout for this Task"} action={() => perform(() => setProvisionTarget(menuTask))} /> : null}
            {canDismissTaskWorktreeProvisioning(menuTask) ? <MenuButton icon="close" label="Dismiss failure" detail="Clear the failed attempt" action={() => perform(() => props.dismissTaskWorktreeProvisioning(menuTask.id, menuTask.worktree_provisioning!.operation_id))} /> : null}
            {menuTask.worktree && menuTask.worktree_generation !== undefined ? <MenuButton icon="trash" label="Cleanup worktree" detail="Review and remove this checkout" action={() => perform(() => setCleanupTarget(menuTask))} /> : null}
            {menuTask.worktree_repair?.dismissible ? <MenuButton icon="close" label="Dismiss repair" detail="No Git mutation was invoked" action={() => perform(() => props.dismissTaskWorktreeRepair(menuTask.id, menuTask.worktree_repair!.operation_id))} /> : null}
            {menuTask.status === "open" ? (
              <MenuButton icon="archive" label="Close Task" detail="Keep its current state" action={() => perform(() => props.setTaskClosed(menuTask.id, true))} />
            ) : (
              <MenuButton icon="reopen" label="Reopen Task" detail="Return it to open work" action={() => perform(() => props.setTaskClosed(menuTask.id, false))} />
            )}
            <MenuButton icon="archive" label="Archive Task" detail="Park safe context and remove it from active work" action={() => perform(() => setArchiveTarget(menuTask))} />
            <div className="context-menu-divider" />
            <MenuButton icon="trash" label={menuTask.worktree ? "Delete Task and worktree" : "Delete Task"} detail={menuTask.worktree ? "Park Agents, remove checkout, then close Task" : "Remove its current record"} danger action={() => perform(() => setDeleteTarget(menuTask))} />
          </div>
        </div>
      ) : null}
      {editor ? <TaskEditor
        state={editor}
        close={() => setEditor(undefined)}
        createTask={props.createTask}
        updateTask={props.updateTask}
        createFlow={{
          projectId: props.projectId,
          repositoryPath: props.projectFolder ?? "",
          rememberedParentPath: lastWorktreeParentPath,
          rememberParentPath,
          listBranches: props.listProjectLocalBranches,
          ...(props.loadProjectTaskAutomation
            ? { loadProjectAutomation: props.loadProjectTaskAutomation }
            : {}),
          agentCapabilities: props.agentCapabilities,
          provisionWorktree: props.provisionTaskWorktree,
          queueLaunches,
        }}
      /> : null}
      {bindTarget ? <BindBranchDialog task={bindTarget} initialRepositoryPath={props.projectFolder ?? ""} close={() => setBindTarget(undefined)} bind={props.bindTaskBranch} /> : null}
      {provisionTarget ? <ProvisionWorktreeDialog task={provisionTarget} projectId={props.projectId} repositoryPath={props.projectFolder ?? ""} rememberedParentPath={lastWorktreeParentPath} rememberParentPath={rememberParentPath} listBranches={props.listProjectLocalBranches} close={() => setProvisionTarget(undefined)} provision={props.provisionTaskWorktree} /> : null}
      {cleanupTarget ? <CleanupWorktreeDialog task={cleanupTarget} close={() => setCleanupTarget(undefined)} inspect={props.inspectTaskWorktreeCleanup} cleanup={props.cleanupTaskWorktree} /> : null}
      {repairTarget ? <RepairWorktreeDialog task={repairTarget} close={() => setRepairTarget(undefined)} inspect={props.inspectTaskWorktreeRepair} repair={props.repairTaskWorktree} /> : null}
      {archiveTarget ? <ArchiveTaskDialog
        task={archiveTarget}
        close={() => setArchiveTarget(undefined)}
        inspect={props.inspectTaskArchive}
        archive={async (ticket) => {
          const failure = await props.archiveTask(archiveTarget.id, ticket);
          if (!failure) props.archivedTasksChanged();
          return failure;
        }}
      /> : null}
      {currentDeleteTarget ? <DeleteTaskDialog
        task={currentDeleteTarget}
        inspect={props.inspectTaskWorktreeCleanup}
        close={() => setDeleteTarget(undefined)}
        closeAfterWorktreeRemoval={Boolean(currentDeleteTarget.worktree)}
        remove={(review) => { void props.deleteTaskAndWorktree(currentDeleteTarget.id, review); }}
      /> : null}
      </OverlayPortal>
    </section>
  );
}

function ArchiveTaskDialog({ task, close, inspect, archive }: {
  task: Task;
  close(): void;
  inspect(taskId: string): Promise<TaskArchivePreviewDto>;
  archive(ticket: string): Promise<string | undefined>;
}) {
  const [preview, setPreview] = useState<TaskArchivePreviewDto>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void inspect(task.id).then((value) => { if (active) setPreview(value); }).catch((failure) => {
      if (active) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { active = false; };
  }, [inspect, task.id]);
  const submit = async () => {
    if (!preview?.can_archive) return;
    setBusy(true); setError(undefined);
    const failure = await archive(preview.archive_ticket);
    if (failure) { setError(failure); setBusy(false); } else close();
  };
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}>
    <button className="dialog-backdrop" aria-label="Cancel Task archive" onClick={close} />
    <section className="dialog-card task-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-task-title">
      <header className="dialog-header"><div><span className="dialog-eyebrow">Task archive</span><h2 id="archive-task-title">Archive “{task.title}”?</h2></div><button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button></header>
      <div className="dialog-body">
        <p className="confirm-copy">The Task leaves the active workflow. Its branch and worktree are kept; attached resumable Agents are parked for restore.</p>
        {preview?.sessions.length ? <div className="field-help"><strong>Associated Project Sessions</strong><ul>{preview.sessions.map((session) => <li key={session.session_id}>{session.name?.trim() || session.agent_id || session.kind}: {session.disposition === "willParkAndResume" ? "park and resume on restore" : session.disposition === "willPreservePlaceholder" ? "preserve as stopped context" : session.blocker ?? "blocks archive"}</li>)}</ul></div> : <p className="field-help">No Project Sessions are associated with this Task worktree.</p>}
        {preview?.blockers.length ? <div className="form-error" role="alert"><strong>Archive is blocked.</strong><ul>{preview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="danger-button" disabled={busy || !preview?.can_archive} onClick={() => void submit()}>{busy ? "Archiving…" : preview && !preview.can_archive ? "Archive blocked" : "Archive Task"}</button></footer>
    </section>
  </div>;
}


type TaskGroupProps = {
  projectId: string | undefined;
  task: Task;
  gitHostProjection: GitHostProjection | undefined;
  branchCommitSummary: BranchCommitSummary | undefined;
  runConfigurations: readonly RunConfiguration[];
  runRuntimes: readonly RunRuntime[];
  runStateRevision: number;
  openExternal(url: string, runSessionId?: string): Promise<void>;
  sessionsById: ReadonlyMap<string, Session>;
  agentGroups?: readonly AgentGroupLayout[] | undefined;
  detachedRelationshipSessionIds?: ReadonlySet<string> | undefined;
  detachRelationship?: ((sessionId: string) => void) | undefined;
  renameAgentGroup?: ((sessionId: string, name: string) => void) | undefined;
  ungroupAgentGroup?: ((sessionId: string) => void) | undefined;
  statusesById: ReadonlyMap<string, AgentStatus>;
  reviewReadySessionIds: ReadonlySet<string>;
  selectedSessionId: string | undefined;
  visibleSessionIds: ReadonlySet<string>;
  menuSessionId: string | undefined;
  selectSession(sessionId: string): void;
  openSessionMenu(sessionId: string, x: number, y: number, invoker: HTMLElement): void;
  dismissSession(sessionId: string): void;
  resumeSession(sessionId: string): void;
  openMenu(task: Task, x: number, y: number, invoker: HTMLElement): void;
  createWorktree(task: Task): void;
  inspectRepair(task: Task): void;
  agentCapabilities: readonly AgentCapabilityDto[];
  launchTerminal(taskId: string): Promise<string | undefined>;
  launchAgent(taskId: string, agentId: string): Promise<string | undefined>;
  runImprovement: RunImprovement;
  setupRunImprovement(projectId: string, target: RunConfigurationImproverTarget): void;
  saveRunConfiguration(params: RunConfigurationCreateParams | RunConfigurationUpdateParams): Promise<RunConfigurationDto | string>;
  deleteRunConfiguration(configurationId: string): Promise<string | undefined>;
  launchTaskRun(taskId: string, configurationId: string, restart: boolean, forceSetup?: boolean): Promise<string | undefined>;
  overlayContainer: Element | undefined;
  overlayVisibilityChanged(visible: boolean): void;
  openChanges(taskId: string, source: ChangesOpenSource): void;
  openDetail(taskId: string): void;
  detailOpen: boolean;
  deleting: boolean;
  provisioning: boolean;
  nowEpochMs: number;
  focused: boolean;
};

/// One Task rendered as the legacy worktree group: a quiet header line, then the
/// Sessions running inside its checkout and the launchers for that checkout.
const TaskGroup = memo(function TaskGroup(props: TaskGroupProps) {
  const { task, sessionsById } = props;
  const sidebarDnd = useOptionalSidebarSessionDnd();
  const relocationDropEnabled = taskRelocationDropEnabled(task, sessionsById, props.deleting, sidebarDnd?.draggedSession);
  const relocationDrop = useDroppable({
    id: `task:${task.id}`,
    data: { kind: "task", taskId: task.id },
    disabled: !relocationDropEnabled,
  });
  const [storedCollapsed, setStoredCollapsed] = useState(() => readTaskCollapsed(
    props.projectId,
    task.id,
    task.status === "closed",
  ));
  /// While an open Task has a live agent it discloses itself, so active work
  /// never hides behind a chevron preference recorded when the Task was quiet.
  /// A chevron click during that window wins, but only until the Task goes
  /// quiet: disclosure then returns to the stored preference and auto-open
  /// re-arms for the next agent.
  const [liveCollapsed, setLiveCollapsed] = useState<boolean>();
  const stage = taskStage(task, props.deleting, props.provisioning);
  const divergence = taskDivergence(task);
  const changeCount = taskChangeCount(task);
  /// `ready` is exactly "a healthy worktree with nothing in front of it", which
  /// is the same gate the launchers need. Deriving it from the stage keeps the
  /// two from drifting and drops a second `taskWorktreeInlineAction` call.
  const launchable = stage.id === "ready";
  const commitCount = props.branchCommitSummary?.freshness === "fresh"
    ? props.branchCommitSummary.count
    : null;
  const integration = taskIntegration(props.gitHostProjection, props.branchCommitSummary);
  const sessions = useMemo(
    () => taskSessions(task, sessionsById),
    [task, sessionsById],
  );
  const attention = useMemo(
    () => agentAttention(sessions, props.statusesById, props.reviewReadySessionIds),
    [sessions, props.statusesById, props.reviewReadySessionIds],
  );
  const liveAgents = sessions
    .filter((session) => session.kind === "Agent" && isLiveSession(session))
    .map((session) => ({
      session,
      state: sessionState(session, props.statusesById.get(session.id), props.reviewReadySessionIds.has(session.id)),
      priority: agentActivityPriority(session, props.statusesById.get(session.id), props.reviewReadySessionIds.has(session.id)),
    }))
    .sort((left, right) => left.priority - right.priority);
  /// Closed Tasks stay quiet by design, so only an open Task self-discloses.
  const hasLiveAgent = task.status === "open" && liveAgents.length > 0;
  useEffect(() => {
    if (!hasLiveAgent) setLiveCollapsed(undefined);
  }, [hasLiveAgent]);
  const collapsed = hasLiveAgent ? liveCollapsed ?? false : storedCollapsed;
  const toggleCollapsed = () => {
    const next = !collapsed;
    if (hasLiveAgent) setLiveCollapsed(next);
    setStoredCollapsed(next);
    writeTaskCollapsed(props.projectId, task.id, next);
  };
  /// A row click means "show me this Task": it discloses the row in place and
  /// puts the detail on the stage. Once the detail is already showing, the
  /// click has nothing left to reveal, so a repeat press folds the row back —
  /// and the next one grows it again. Both directions persist like the chevron.
  const rowClick = () => {
    if (props.detailOpen) {
      toggleCollapsed();
      return;
    }
    if (collapsed) toggleCollapsed();
    props.openDetail(task.id);
  };
  const sessionGroups = useMemo(
    () => taskSessionGroupsByActivity(sessions, props.statusesById, props.reviewReadySessionIds, props.nowEpochMs, props.agentGroups ?? [], props.detachedRelationshipSessionIds ?? new Set()),
    [sessions, props.agentGroups, props.detachedRelationshipSessionIds, props.statusesById, props.reviewReadySessionIds, props.nowEpochMs],
  );
  const agents = useMemo(
    () => props.agentCapabilities.filter((capability) => capability.available),
    [props.agentCapabilities],
  );
  const runtimeBySession = useMemo(
    () => runtimesBySessionId(props.runRuntimes),
    [props.runRuntimes],
  );
  const runCommandBySession = useMemo(
    () => runCommandsBySessionId(props.runRuntimes, props.runConfigurations),
    [props.runRuntimes, props.runConfigurations],
  );
  useEffect(() => {
    taskRowRenderCount += 1;
  });
  const openPullRequest = (pullRequest: GitHostProjection["matches"][number]) => props.openChanges(task.id, {
    kind: "pullRequest",
    pullRequest: pullRequestIdentity(pullRequest),
    freshnessGeneration: props.gitHostProjection?.freshness_generation ?? 0,
  });
  const firstPullRequest = props.gitHostProjection?.matches[0];
  const branchChanges = commitCount
    ? {
        label: `${commitCount} ${commitCount === 1 ? "commit" : "commits"}`,
        title: `Review the combined changes from ${commitCount} ${commitCount === 1 ? "commit" : "commits"} on this Task branch since its base.`,
        ariaLabel: `Review all branch changes in ${task.title}`,
        open: () => props.openChanges(task.id, { kind: "commits" } as const),
      }
    : firstPullRequest
      ? {
          label: `${props.gitHostProjection!.matches.length} pushed ${props.gitHostProjection!.matches.length === 1 ? "PR" : "PRs"}`,
          title: `The recorded Task branch is unavailable; review pushed changes through ${props.gitHostProjection!.matches.length} matching ${props.gitHostProjection!.matches.length === 1 ? "pull request" : "pull requests"}.`,
          ariaLabel: `Review pushed pull request changes in ${task.title}`,
          open: () => openPullRequest(firstPullRequest),
        }
      : undefined;
  /// The integration signal opens whichever pull request the projection already
  /// chose for its label, so the two cannot disagree.
  const openIntegration = integration?.action === "pullRequest" && integration.pullRequest
    ? () => openPullRequest(integration.pullRequest!)
    : integration?.action === "commits"
      ? () => props.openChanges(task.id, { kind: "commits" })
      : undefined;
  /// Every row keeps the same anatomy whether collapsed or expanded: one status
  /// dot, one single-line title, the live agent dots, one mono meta line, and at
  /// most one action. The chevron only folds the children away.
  ///
  /// The agent cue stands in for the agent rows the chevron folded away, so it
  /// exists only while they are hidden — expanded, the waiting agent's own row
  /// sits directly below and the cue would say the same thing twice. Structural
  /// next steps have no expanded counterpart and stay on every row.
  const action = props.deleting ? undefined : taskPrimaryAction(stage, collapsed ? attention : undefined);
  return (
    <div
      ref={relocationDrop.setNodeRef}
      role="listitem"
      className={`task-group${props.focused ? " focused" : ""}${relocationDrop.isOver ? " session-drop-target" : ""}`}
      data-task-stage={stage.id}
      data-disclosed={!collapsed && !props.deleting ? "true" : undefined}
      data-session-drop-target={task.status === "open" && task.archived_at_epoch_ms === null && !props.deleting ? task.id : undefined}
    >
      <div className={`task-row${props.deleting ? " deleting" : ""}`}>
        <button
          type="button"
          className="task-toggle"
          aria-expanded={!collapsed}
          disabled={props.deleting}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${task.title}`}
          onClick={toggleCollapsed}
        ><Icon name="chevronDown" /></button>
        {/* Clicking the row opens the Task on the stage, where the pipeline and
            the rest of its detail live, and discloses the row's own Sessions in
            place at the same time; with the detail already showing, the click
            toggles that disclosure instead. Editing stays in the actions menu
            so a first click can never open a modal. */}
        <button
          type="button"
          className={`task-item ${task.status}${props.detailOpen ? " showing-detail" : ""}`}
          disabled={props.deleting}
          data-task-id={task.id}
          aria-current={props.detailOpen ? "true" : undefined}
          aria-label={`Open ${taskRowAccessibleName({ task, stage, attention, divergence, changeCount, integration, commitCount })}`}
          title={task.brief ? `${task.title} — ${task.brief}` : task.title}
          onClick={rowClick}
          onContextMenu={(event) => { event.preventDefault(); props.openMenu(task, event.clientX, event.clientY, event.currentTarget); }}
          onKeyDown={(event) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              props.openMenu(task, rect.left + 14, rect.top + 14, event.currentTarget);
            }
          }}
        >
          <span className="task-headline">
            <i className={`task-dot ${taskRowTone(stage, attention)}`} aria-hidden="true" />
            {props.focused ? <span className="task-focus-copy">
              <strong className="task-title">{task.title}</strong>
              {task.brief ? <small className="task-focus-brief">{task.brief}</small> : null}
            </span> : <strong className="task-title">{task.title}</strong>}
          </span>
        </button>
        {/* One dot per live agent, loudest first, capped so the title keeps its
            width. Clicking a dot opens that agent's terminal without expanding
            the Task; the full Session rows stay behind the chevron. */}
        {liveAgents.length > 0 && !props.deleting ? (
          <span className="task-agents" role="group" aria-label={`${liveAgents.length} live ${liveAgents.length === 1 ? "agent" : "agents"} in ${task.title}`}>
            {liveAgents.slice(0, 4).map(({ session, state }) => (
              <button
                key={session.id}
                type="button"
                className={`task-agent-dot${session.process.agent_id ? ` agent-${session.process.agent_id}` : ""}`}
                data-tone={state.tone}
                title={`${agentName(session)}: ${state.label ?? "Idle"}. Opens its terminal without expanding the Task.`}
                aria-label={`Open ${agentName(session)} terminal — ${state.label ?? "idle"}`}
                onClick={() => props.selectSession(session.id)}
              ><i aria-hidden="true" /></button>
            ))}
            {liveAgents.length > 4 ? <span className="task-agents-more" aria-hidden="true">+{liveAgents.length - 4}</span> : null}
          </span>
        ) : null}
        <div className="row-actions">
          <button
            type="button"
            className="row-action"
            aria-haspopup="menu"
            aria-label={`More actions for ${task.title}`}
            disabled={props.deleting}
            title="Task actions"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              props.openMenu(task, rect.right, rect.bottom + 4, event.currentTarget);
            }}
          ><Icon name="more" /></button>
        </div>
      </div>
      <TaskMetaLine
        task={task}
        stage={stage}
        divergence={divergence}
        changeCount={changeCount}
        branchChanges={branchChanges}
        integration={integration}
        openChanges={() => props.openChanges(task.id, { kind: "local" })}
        openIntegration={openIntegration}
        openIssue={() => { if (task.jira_url) void props.openExternal(task.jira_url); }}
      />
      {props.focused && !props.deleting ? <dl className="task-focus-facts">
        <div><dt>Status</dt><dd className={attention?.tone}>{attention ? `${attention.label} — ${attention.agent}` : stage.summary}</dd></div>
        <div><dt>Checkout</dt><dd title={task.worktree?.path ?? "No worktree created"}>{task.worktree ? basename(task.worktree.path) : "Not created"}</dd></div>
      </dl> : null}
      {action ? (
        action.kind === "nextStep" ? (
          <button
            type="button"
            className={`task-next-step ${action.nextStep.emphasis}`}
            aria-label={`${action.nextStep.label} for ${task.title}`}
            onClick={action.nextStep.kind === "repairWorktree" ? () => props.inspectRepair(task) : () => props.createWorktree(task)}
          >
            <Icon name={nextStepIcons[action.nextStep.kind]} />
            {action.nextStep.label}
          </button>
        ) : (
          <button
            type="button"
            className={`task-next-step ${action.attention.tone}`}
            title={`${action.attention.agent}: ${action.attention.label}. Opens its terminal without expanding the Task.`}
            aria-label={`Open ${action.attention.agent} terminal — ${action.attention.label}`}
            onClick={() => props.selectSession(action.attention.sessionId)}
          >
            <Icon name="play" />
            {action.attention.label} · open {action.attention.agent}
          </button>
        )
      ) : null}
      {collapsed || props.deleting ? null : (
        <div className="task-children">
          <GitHostPullRequests
            projection={props.gitHostProjection}
            openChanges={openPullRequest}
            openExternal={props.openExternal}
            compact
          />
          {sessionGroups.map((cluster) => (
            <Fragment key={cluster.key}>
              <AgentGroupFrame
                cluster={cluster}
                compact
                renameGroup={props.renameAgentGroup}
                ungroup={props.ungroupAgentGroup}
              >
                {cluster.groups.map(({ source, helpers }) => (
                  <Fragment key={source.id}>
                    <TaskSessionRow
                      session={source}
                      dropPlacement={sidebarDnd?.sessionDropTarget?.surface !== "group"
                        && sidebarDnd?.sessionDropTarget?.sessionId === source.id
                        ? sidebarDnd.sessionDropTarget.placement
                        : undefined}
                    >{({ dragAttributes, dragListeners }) => <>
                      <SessionRowButton
                        session={source}
                        agentStatus={props.statusesById.get(source.id)}
                        reviewReady={props.reviewReadySessionIds.has(source.id)}
                        runCommand={runCommandBySession.get(source.id)}
                        subtitle={relativeCwd(source.process.cwd, task.worktree?.path ?? "")}
                        active={source.id === props.selectedSessionId}
                        visible={props.visibleSessionIds.has(source.id)}
                        menuOpen={source.id === props.menuSessionId}
                        {...(dragAttributes ? { dragAttributes, dragListeners } : {})}
                        select={() => props.selectSession(source.id)}
                        openMenu={(x, y, invoker) => props.openSessionMenu(source.id, x, y, invoker)}
                      />
                      <SessionRowClose session={source} dismiss={() => props.dismissSession(source.id)} resume={() => props.resumeSession(source.id)} />
                    </>}</TaskSessionRow>
                    <AgentPlanDisclosure
                      session={source}
                      status={props.statusesById.get(source.id)}
                      selected={source.id === props.selectedSessionId}
                      showWorkspace
                    />
                    {runtimeBySession.get(source.id) ? <RunSessionLine
                      session={source}
                      runtime={runtimeBySession.get(source.id)!}
                      restart={() => props.launchTaskRun(task.id, runtimeBySession.get(source.id)!.configurationId, true)}
                      stop={() => props.dismissSession(source.id)}
                      openExternal={props.openExternal}
                    /> : null}
                    {helpers.map((helper) => (
                      <Fragment key={helper.id}>
                        <AskToHelperRow
                          source={source}
                          helper={helper}
                          relationshipLabel={sessionRelationshipLabel(source, helper)}
                          agentStatus={props.statusesById.get(helper.id)}
                          reviewReady={props.reviewReadySessionIds.has(helper.id)}
                          subtitle={relativeCwd(helper.process.cwd, task.worktree?.path ?? "")}
                          active={helper.id === props.selectedSessionId}
                          visible={props.visibleSessionIds.has(helper.id)}
                          menuOpen={helper.id === props.menuSessionId}
                          compact
                          relocatable={isProjectRelocationDragCandidate(helper)}
                          select={() => props.selectSession(helper.id)}
                          openMenu={(x, y, invoker) => props.openSessionMenu(helper.id, x, y, invoker)}
                          dismiss={() => props.dismissSession(helper.id)}
                          resume={() => props.resumeSession(helper.id)}
                          {...(props.detachRelationship ? { detachRelationship: () => props.detachRelationship!(helper.id) } : {})}
                        />
                        <AgentPlanDisclosure
                          session={helper}
                          status={props.statusesById.get(helper.id)}
                          selected={helper.id === props.selectedSessionId}
                          showWorkspace
                          nested
                        />
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </AgentGroupFrame>
            </Fragment>
          ))}
          {launchable ? (
            <div className="task-launch" role="group" aria-label={`Start a new Session in ${task.title}`}>
              <span className="task-launch-label" aria-hidden="true">Start</span>
              <button type="button" className="task-launch-icon" title="New Terminal" aria-label={`Open a terminal in ${task.title}`} onClick={() => void props.launchTerminal(task.id)}><Icon name="terminal" /></button>
              {agents.map((capability) => (
                <button
                  key={capability.agent_id}
                  type="button"
                  className={`task-launch-icon agent-${capability.agent_id}`}
                  title={`New ${capability.label} Session${capability.integration_level === "launchOnly" ? " (launch only)" : ""}`}
                  aria-label={`Start ${capability.label} in ${task.title}`}
                  onClick={() => void props.launchAgent(task.id, capability.agent_id)}
                ><Icon name={capability.agent_id === "claude" ? "claude" : capability.agent_id === "codex" ? "codex" : "agent"} /></button>
              ))}
              <TaskRunLaunchers
                projectId={task.project_id}
                task={task}
                configurations={props.runConfigurations}
                runtimes={props.runRuntimes}
                sessionsById={props.sessionsById}
                stateRevision={props.runStateRevision}
                launchable={launchable}
                overlayContainer={props.overlayContainer}
                overlayVisibilityChanged={props.overlayVisibilityChanged}
                improvement={props.runImprovement}
                setupImprovement={props.setupRunImprovement}
                save={props.saveRunConfiguration}
                remove={props.deleteRunConfiguration}
                launch={props.launchTaskRun}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
/// Only value props are compared. The callbacks are re-created per render, and a
/// scoped Task patch must re-render exactly the one Task it changed — every
/// value listed here keeps its identity while its own Task is untouched.
}, (left, right) => left.task === right.task
  && left.gitHostProjection === right.gitHostProjection
  && left.branchCommitSummary === right.branchCommitSummary
  && left.runConfigurations === right.runConfigurations
  && left.runRuntimes === right.runRuntimes
  && left.runStateRevision === right.runStateRevision
  && left.sessionsById === right.sessionsById
  && left.agentGroups === right.agentGroups
  && left.renameAgentGroup === right.renameAgentGroup
  && left.ungroupAgentGroup === right.ungroupAgentGroup
  && left.statusesById === right.statusesById
  && left.reviewReadySessionIds === right.reviewReadySessionIds
  && left.selectedSessionId === right.selectedSessionId
  && left.visibleSessionIds === right.visibleSessionIds
  && left.menuSessionId === right.menuSessionId
  && left.deleting === right.deleting
  && left.nowEpochMs === right.nowEpochMs
  && left.agentCapabilities === right.agentCapabilities
  && left.setupRunImprovement === right.setupRunImprovement);

function TaskSessionRow({ session, dropPlacement, children }: {
  session: Session;
  dropPlacement?: SessionDropPlacement | undefined;
  children(drag: {
    dragAttributes: DraggableAttributes | undefined;
    dragListeners: DraggableSyntheticListeners;
  }): ReactNode;
}) {
  const draggableAgent = session.kind === "Agent";
  const draggable = useDraggable({
    id: `task-session:${session.id}`,
    data: { kind: "session", sessionId: session.id },
    disabled: !draggableAgent,
  });
  const droppable = useDroppable({
    id: `task-session-target:${session.id}`,
    data: { kind: "session", sessionId: session.id },
    disabled: session.kind !== "Agent",
  });
  const setNodeRef = useCallback((node: HTMLDivElement | null) => {
    draggable.setNodeRef(node);
    droppable.setNodeRef(node);
  }, [draggable.setNodeRef, droppable.setNodeRef]);
  return (
    <div
      ref={setNodeRef}
      className={`session-row task-session${draggableAgent ? " with-drag-handle" : ""}${draggable.isDragging ? " dragging" : ""}${dropPlacement ? ` drop-${dropPlacement}` : ""}`}
      role="listitem"
      data-session-drop-target={session.kind === "Agent" ? session.id : undefined}
    >
      {draggableAgent ? <button
        className="session-drag-handle"
        type="button"
        aria-label={`Move ${session.name ?? session.process.agent_id ?? "Agent"}`}
        {...draggable.attributes}
        {...draggable.listeners}
        onClick={(event) => event.stopPropagation()}
      ><Icon name="grip" /></button> : null}
      {children({
        dragAttributes: draggableAgent ? draggable.attributes : undefined,
        dragListeners: draggableAgent ? draggable.listeners : undefined,
      })}
    </div>
  );
}

type TaskMetaLineProps = {
  task: Task;
  stage: TaskStage;
  divergence: TaskDivergence | undefined;
  changeCount: number | undefined;
  branchChanges: {
    label: string;
    title: string;
    ariaLabel: string;
    open(): void;
  } | undefined;
  integration: TaskIntegration | undefined;
  openChanges(): void;
  /// Already bound to the exact pull request or commit list the integration
  /// label describes; `undefined` when the fact is not openable.
  openIntegration: (() => void) | undefined;
  openIssue(): void;
};

const nextStepIcons: Record<TaskNextStepKind, "add" | "focus"> = {
  createWorktree: "add",
  retryWorktree: "add",
  repairWorktree: "focus",
};

/// One inline machine fact. Renders as a button when it opens something and as
/// plain text when it only states something, so the call sites below differ only
/// in their content rather than repeating the element once per tag.
function Signal({ tone, label, title, ariaLabel, onClick }: {
  tone: TaskSignalTone | "issue";
  label: string;
  title: string;
  ariaLabel?: string;
  onClick?: (() => void) | undefined;
}) {
  const className = `task-signal ${tone}`;
  return onClick
    ? <button type="button" className={className} title={title} aria-label={ariaLabel} onClick={onClick}>{label}</button>
    : <small className={className} title={title}>{label}</small>;
}

/// Everything TermLoop derived about a Task lives on this one mono line, on
/// every row, collapsed or not: an off-nominal stage flag first, then the branch
/// (the only token that shrinks), then the derived Git facts. A settled Task
/// reads as one short dim line; a blocked one carries a single accent in a
/// position the eye already knows.
///
/// A Task being deleted states its stage and nothing else: every other item
/// here is a fact about to disappear.
function TaskMetaLine(props: TaskMetaLineProps) {
  const { task, stage, divergence, changeCount, branchChanges, integration } = props;
  const deleting = stage.id === "deleting";
  /// A closed Task keeps its identity but stops asking for anything: its
  /// signals would spend attention colour on work the user explicitly parked,
  /// and every one of them survives on the detail page.
  const quiet = stage.id === "closed";
  const separator = <span className="task-meta-sep" aria-hidden="true">·</span>;
  /// The Jira key is a click affordance, not identity — when the user already
  /// put the key in the title, printing it again is pure repetition.
  const jiraKey = task.jira_url ? taskJiraIssueKey(task.jira_url) : undefined;
  const showJira = Boolean(task.jira_url && jiraKey && !task.title.includes(jiraKey));
  /// The worktree path rides the branch tooltip: the row itself never spends
  /// width on the folder, but the full path stays one hover away.
  const worktreeSuffix = task.worktree ? ` · Worktree ${task.worktree.path}` : "";
  return (
    <div className="task-meta">
      {stage.flag ? (
        <em className={`task-meta-flag ${stage.tone}`} title={stage.summary}>
          {stage.tone === "busy" ? <span className="task-pulse" aria-hidden="true" /> : null}
          {stage.flag}
        </em>
      ) : null}
      {/* A diverged checkout replaces the branch token instead of joining it:
          "on <checked-out>" is the operative fact, and the Task branch it
          displaced stays in that signal's tooltip. */}
      {deleting ? null : divergence && !quiet ? (
        <Signal tone="attention" label={divergence.text} title={divergence.title} />
      ) : (
        <small
          className={`task-meta-branch${task.branch ? "" : " none"}`}
          title={task.branch ? `Task branch ${task.branch.name}${worktreeSuffix}` : `No branch is bound to this Task${worktreeSuffix}`}
        >
          {task.branch ? task.branch.name : "No branch"}
        </small>
      )}
      {deleting || quiet ? null : (
        <>
          {changeCount ? (
            <>
              {separator}
              <Signal
                tone="review"
                label={taskChangeLabel(changeCount)}
                title={`${taskChangedFileLabel(changeCount)} uncommitted in this checkout.`}
                ariaLabel={`Review ${taskChangedFileLabel(changeCount)} in ${task.title}`}
                onClick={props.openChanges}
              />
            </>
          ) : null}
          {branchChanges ? (
            <>
              {separator}
              <Signal
                tone="review"
                label={branchChanges.label}
                title={branchChanges.title}
                ariaLabel={branchChanges.ariaLabel}
                onClick={branchChanges.open}
              />
            </>
          ) : null}
          {integration ? (
            <>
              {separator}
              <Signal
                tone={integrationTone(integration, Boolean(changeCount))}
                label={integration.label}
                title={integration.title}
                onClick={props.openIntegration}
              />
            </>
          ) : null}
          {showJira ? (
            <>
              {separator}
              <Signal
                tone="issue"
                label={jiraKey!}
                title={`Open ${task.jira_url} in browser`}
                ariaLabel={`Open Jira ${jiraKey} in browser`}
                onClick={props.openIssue}
              />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/// Shared with the Task detail page so a pull request reads the same in the
/// rail and on the page it opens; both derive it from the same projection.
///
/// `compact` is the rail's form: one mono line per pull request — number,
/// target, state. The head branch is almost always the Task branch printed one
/// line above, and the PR title is almost always the Task title, so both live
/// in the tooltip instead of being repeated on screen. The detail page keeps
/// the full two-line form.
export function GitHostPullRequests({ projection, openChanges, openExternal, compact = false }: {
  projection: GitHostProjection | undefined;
  openChanges(pullRequest: GitHostProjection["matches"][number]): void;
  openExternal(url: string, runSessionId?: string): Promise<void>;
  compact?: boolean;
}) {
  /// Owns its own emptiness so the parent never has to predict it: a projection
  /// with zero matches renders nothing rather than an empty list container.
  if (!projection || projection.matches.length === 0) return null;
  return (
    <div className="task-pr-list">
      {projection.matches.map((pullRequest) => (
        <div
          key={`${pullRequest.provider}|${pullRequest.host}|${pullRequest.repository_owner}|${pullRequest.repository_project ?? ""}|${pullRequest.repository_name}#${pullRequest.number}`}
          className="task-pr-actions"
        >
          <button
            type="button"
            className={`task-pr${compact ? " compact" : ""} task-signal ${projection.freshness}`}
            title={`${pullRequest.provider === "azureDevOps" ? "Azure DevOps" : "GitHub"} pull request #${pullRequest.number} · ${pullRequest.head_branch} → ${pullRequest.base_branch} · ${pullRequest.state} · ${pullRequest.title}`}
            onClick={() => openChanges(pullRequest)}
          >
            <span className="task-signal-label">#{pullRequest.number}</span>
            {compact ? (
              <span className="task-pr-base" aria-label={`targets ${pullRequest.base_branch}`}>→ {pullRequest.base_branch}</span>
            ) : (
              <span className="task-pr-copy">
                <span className="task-pr-branches" title={`${pullRequest.head_branch} → ${pullRequest.base_branch}`}>
                  <span className="task-pr-head">{pullRequest.head_branch}</span>
                  <span className="task-pr-base" aria-label={`targets ${pullRequest.base_branch}`}>→ {pullRequest.base_branch}</span>
                </span>
                <span className="task-pr-title" title={pullRequest.title}>{pullRequest.title}</span>
              </span>
            )}
            <span className="task-pr-state">{pullRequest.state}</span>
          </button>
          <button
            type="button"
            className="task-pr-external"
            aria-label={`Open pull request ${pullRequest.number} in browser`}
            title="Open in browser"
            onClick={() => void openExternal(pullRequest.url)}
          ><span aria-hidden="true">↗</span></button>
        </div>
      ))}
    </div>
  );
}

function relativeCwd(cwd: string, worktreePath: string): string {
  if (!worktreePath || cwd === worktreePath) return "";
  return cwd.startsWith(`${worktreePath}/`) ? cwd.slice(worktreePath.length + 1) : basename(cwd);
}
