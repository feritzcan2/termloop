import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useDroppable } from "@dnd-kit/core";
import { MAX_LAYOUT_PANES, panes, type AgentGroupLayout, type LayoutNode, type ProjectLayout, type SplitDirection, type SplitNode, type SplitPlacement } from "../../layout/model.js";
import type { AgentStatus, BranchCommitSummary, ConnectionState, GitHostProjection, Project, ProjectWorktreeSummary, RunConfiguration, RunRuntime, Session, Task, TaskDeleteWorktreeResult, TaskDeleteWorktreeReview } from "../model.js";
import { basename, isLiveSession, sessionDismissCommand, sessionIsImprover, sessionKeepsTerminalSurface, sessionLabel, sessionResumeActionLabel } from "../model.js";
import { agentActivityPriority } from "../session-presentation.js";
import { DoubleShiftDetector, keyboardPlatform, matchesShellShortcut, nativeProjectShortcutIndex, nativeShellCommandId, projectShortcutIndex, projectShortcutLabel, shellShortcutsBlocked, showsWindowDragRegion, type ShellCommand, type ShellShortcutId } from "../command-surface.js";
import { Icon } from "./Icon.js";
import { ProjectCheckoutHeader } from "./ProjectCheckoutHeader.js";
import { ProjectSourceRefreshButton } from "./ProjectSourceRefreshButton.js";
import { SessionRail } from "./SessionRail.js";
import { SessionContextMenu, type SessionAgentActions, type SessionMenuState, type SessionRunDevServer } from "./SessionRow.js";
import { TaskRail, askToHelpersForSources, taskAttachedSessionIds, taskSessions } from "./TaskRail.js";
import { TaskDetailPanel } from "./TaskDetailPanel.js";
import { OverlayPortal } from "./OverlayPortal.js";
import { DEV_SERVER_SEED, RunEditorDialog } from "./TaskRuns.js";
import type { RunImprovement } from "./TaskRuns.js";
import { ArchivedRail, archivedRailVisible, useArchivedTasks } from "./ArchivedRail.js";
import { useDeletedSessions } from "./DeletedRail.js";
import { ChangesOverlay, type ChangesSubject } from "./ChangesOverlay.js";
import { taskReviewAgentSessions } from "../changes-review.js";
import type { AgentCapabilityDto, AssistantPromptImproverTarget, GitHostPullRequestChangeListResult, GitHostPullRequestDiffResult, GitHostPullRequestIdentityDto, KeepAwakeSetParams, KeepAwakeStatusResult, McpToolDescriptionResetParams, McpToolDescriptionUpdateParams, McpToolSettingsResult, PlaybookRuntimeResult, ProjectLocalBranchListResult, ProjectWorktreeChangeListResult, ProjectWorktreeDiffResult, ProjectWorktreePreImageResult, QuickActionPreviewResult, RunConfigurationCreateParams, RunConfigurationDto, RunConfigurationImproverTarget, RunConfigurationUpdateParams, SessionRelocationPreviewDto, SettingsImproverTarget, TaskArchivePreviewDto, TaskBranchCommitChangeListResult, TaskBranchCommitDiffResult, TaskBranchCommitListResult, TaskCleanupWorktreeParams, TaskProvisionWorktreeParams, TaskRepairWorktreeParams, TaskWorktreeChangeListResult, TaskWorktreeCleanupPreviewDto, TaskWorktreeDiffResult, TaskWorktreePreImageResult, TaskWorktreeRepairPreviewDto } from "@termloop/contract/current";
import type { DeletedSessionDto, SessionHistoryPreviewResult } from "@termloop/contract/current";
import type { ChangesOpenSource } from "../change-source.js";
import { CommandPalette, KeyboardShortcutsDialog } from "./CommandPalette.js";
import { QuickActionComposer } from "./QuickActionComposer.js";
import { AgentSetupDialog } from "./AgentSetupDialog.js";
import type { QuickActionImageHandle } from "../../quick-action-image.js";
import { useSettingsLibrary } from "./settings-library.js";
import { StageEditorPlaceholder } from "./StageEditorPlaceholder.js";
import { promptImproveTarget, type PromptAsset } from "../prompt-settings.js";
import type { QuickActionAgentSelection } from "../quick-action-memory.js";
import { McpRail } from "./McpRail.js";
import { McpToolPanel } from "./McpToolPanel.js";
import { PromptPanel } from "./PromptPanel.js";
import { PromptsRail } from "./PromptsRail.js";
import { SkillEditorPanel } from "./SkillEditorPanel.js";
import { SkillsRail } from "./SkillsRail.js";
import { ContextBankEditorPanel } from "./ContextBankEditorPanel.js";
import { ContextBankRail } from "./ContextBankRail.js";
import { KeepAwakePanel } from "./KeepAwakePanel.js";
import type { McpSettingsMutationResult } from "../mcp-settings.js";
import { AssistantRail, isAssistantSession, type AssistantSelection } from "./AssistantRail.js";
import { StewardPanel, type StewardPanelProps } from "./StewardPanel.js";
import { promptImprovementActionLabel, type ConfigurationVersionActions } from "./PromptImprovement.js";
import { StewardPetHost } from "./StewardPetHost.js";
import { SessionRelocationDialog } from "./SessionRelocationDialog.js";
import { SessionProjectRelocationDialog } from "./SessionProjectRelocationDialog.js";
import { ProviderHistoryRepairDialog } from "./ProviderHistoryRepairDialog.js";
import { SidebarSessionDndProvider, isProjectRelocationDragCandidate, isTaskRelocationDragCandidate, useOptionalSidebarSessionDnd } from "./SidebarSessionDnd.js";
import { ActiveAgentRail } from "./ActiveAgentRail.js";
import { HistoryRail } from "./HistoryRail.js";
import { playbookBuilderSession } from "../prompt-improver-session-link.js";
import { WorkspaceViewSwitch, type WorkspaceView } from "./WorkspaceViewSwitch.js";
import type { GhosttyShellShortcut } from "../../ghostty-shell-shortcut.js";
import { persistActiveAgentFavoriteToggle, readActiveAgentFavorites } from "../active-agent-favorites.js";
import { readActiveAgentActivityMemory, updateActiveAgentActivityMemory, writeActiveAgentActivityMemory } from "../active-agent-activity-memory.js";
import { SessionTabStrip } from "./SessionTabStrip.js";
import { TaskSourcesPanel, type TaskSourceActions } from "./TaskSourcesPanel.js";
import type { TaskCreateOutcome } from "./task-dialogs/task-editor.js";
import type { ErrorLogEntry } from "../state/projection-store.js";
import type { SessionHistoryListResult } from "@termloop/contract/current";
import { ErrorLogPanel } from "./ErrorLogPanel.js";
import { MobileConnectDialog } from "./MobileConnectDialog.js";
import type { MobileAccessPairingResult } from "../mobile-access.js";
import { ConnectionProfilesDialog } from "./ConnectionProfilesDialog.js";
import type {
  ConnectionProfileConnectInput,
  ConnectionProfileConnectResult,
  ConnectionProfileSummary,
  ConnectionSourceSummary,
  RemoteHostStatus,
  RemoteHostTransport,
  TailscaleServerDiscovery,
} from "../../connection-profile-types.js";
import { ProjectDialog, ProjectDetailsDialog } from "./project-dialogs/project-dialogs.js";
import { BackgroundSessionRelocation, type BackgroundSessionRelocationIntent } from "../background-session-relocation.js";
import type { FolderPickerActions } from "./project-dialogs/folder-picker.js";
import {
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  clearSidebarWidth,
  readSidebarWidth,
  sidebarMaximumWidth,
  writeSidebarWidth,
} from "../sidebar-width.js";

type AssistantActions = Pick<StewardPanelProps,
  | "getConfiguration" | "setConfiguration" | "listTranscript" | "appendMessage"
  | "respondToProposal" | "acceptSuggestion" | "clearTranscript"
  | "listWorkers" | "createWorker" | "updateWorker" | "deleteWorker"
  | "listRoutines" | "createRoutine" | "updateRoutine" | "updateRoutineContext" | "deleteRoutine"
  | "listRoutineRuntime" | "runRoutineNow" | "getPlaybook" | "getPlaybookRuntime"
  | "promptImprovement"
> & Pick<ComponentProps<typeof TaskDetailPanel>, "setPlaybookTaskPosition">
  & Pick<ComponentProps<typeof AssistantRail>, "updatePlaybook"> & {
  deleteConfiguration(expectedRevision: number): Promise<import("@termloop/contract/current").StewardConfigurationDeleteResult>;
  restartSteward(): Promise<string | null>;
  restartWorker(workerId: string): Promise<string | null>;
};

type ImproverSetup =
  | { kind: "prompt"; projectId: string; target: AssistantPromptImproverTarget }
  | { kind: "run"; projectId: string; target: RunConfigurationImproverTarget }
  | { kind: "settings"; projectId: string; target: SettingsImproverTarget; subject: string };

function improverSetupTitle(setup: ImproverSetup): string {
  if (setup.kind === "run") return "Improve run with agent";
  if (setup.kind === "settings") return `Improve ${setup.subject} with agent`;
  return promptImprovementActionLabel(setup.target.surface);
}

function matchesInteractiveAgentProvider(session: Session): boolean {
  return typeof session.process.agent_id === "string"
    && session.process.agent_id.length <= 64
    && /^[a-z](?:[a-z0-9]|-[a-z0-9])*$/u.test(session.process.agent_id);
}

export type ShellProps = {
  projects: readonly Project[];
  projectTasks: readonly Task[];
  gitHostProjections: readonly GitHostProjection[];
  branchCommitSummaries: readonly BranchCommitSummary[];
  runConfigurations: readonly RunConfiguration[];
  runRuntimes: readonly RunRuntime[];
  runStateRevision: number;
  playbookRuntime: PlaybookRuntimeResult | null;
  projectSessions: readonly Session[];
  projectWorktreeSummary?: ProjectWorktreeSummary | undefined;
  selectedProject: Project | undefined;
  selectedSession: Session | undefined;
  layout: ProjectLayout | undefined;
  visibleSessionIds: ReadonlySet<string>;
  reviewReadySessionIds: ReadonlySet<string>;
  deletingTaskIds: ReadonlySet<string>;
  agentStatuses: readonly AgentStatus[];
  agentCapabilities: readonly AgentCapabilityDto[];
  connection: ConnectionState;
  connectionMessage: string | undefined;
  reconnectSource(profileId: string): Promise<void>;
  isPackaged: boolean;
  errorLog: readonly ErrorLogEntry[];
  clearErrorLog(): void;
  prepareMobileAccess(): Promise<MobileAccessPairingResult>;
  listConnectionProfiles(): Promise<ConnectionProfileSummary[]>;
  connectConnectionProfile(input: ConnectionProfileConnectInput): Promise<ConnectionProfileConnectResult>;
  setConnectionProfileEnabled(profileId: string, enabled: boolean): Promise<ConnectionProfileSummary[]>;
  removeConnectionProfile(profileId: string): Promise<ConnectionProfileSummary[]>;
  subscribeConnectionStatus(listener: (summary: ConnectionSourceSummary) => void): () => void;
  discoverTailscaleServers(): Promise<TailscaleServerDiscovery>;
  remoteHostStatus(): Promise<RemoteHostStatus>;
  enableRemoteHost(transport: RemoteHostTransport): Promise<RemoteHostStatus>;
  disableRemoteHost(): Promise<RemoteHostStatus>;
  loadMcpToolSettings(): Promise<McpToolSettingsResult>;
  updateMcpToolDescription(params: McpToolDescriptionUpdateParams): Promise<McpSettingsMutationResult>;
  resetMcpToolDescription(params: McpToolDescriptionResetParams): Promise<McpSettingsMutationResult>;
  loadPromptAssets(): Promise<import("../prompt-settings.js").PromptAsset[]>;
  updatePromptAsset(id: string, body: string): Promise<import("../prompt-settings.js").PromptAsset[]>;
  resetPromptAsset(id: string): Promise<import("../prompt-settings.js").PromptAsset[]>;
  loadSkillCatalog(): Promise<import("@termloop/contract/current").SkillCatalogResult>;
  setSkillDeployment(
    skillId: string,
    agent: "claude" | "codex",
    deployed: boolean,
  ): Promise<import("@termloop/contract/current").SkillCatalogResult>;
  loadSkillDefinition(skillId: string): Promise<import("@termloop/contract/current").SkillDefinitionDto>;
  saveSkillDefinition(
    skillId: string,
    expectedContentSha256: string,
    content: string,
  ): Promise<import("@termloop/contract/current").SkillDefinitionDto>;
  loadContextBankCatalog(): Promise<import("@termloop/contract/current").ContextBankCatalogResult>;
  loadContextBankFile(fileId: string): Promise<import("@termloop/contract/current").ContextBankFileDto>;
  saveContextBankFile(
    fileId: string,
    expectedContentSha256: string,
    content: string,
  ): Promise<import("@termloop/contract/current").ContextBankFileDto>;
  resolveContextBankSiblingConflict(
    conflictId: string,
    sourceFileId: string,
  ): Promise<import("@termloop/contract/current").ContextBankCatalogResult>;
  loadKeepAwake(): Promise<KeepAwakeStatusResult>;
  setKeepAwake(params: KeepAwakeSetParams): Promise<KeepAwakeStatusResult>;
  keepAwakeRefreshToken: number;
  assistantActions: AssistantActions;
  assistantRefreshToken: number;
  taskSourceActions: TaskSourceActions;
  taskSourceRefreshToken: number;
  projectDialogOpen: boolean;
  selectProject(projectId: string): void;
  selectSession(sessionId: string): void;
  navigateSession(sessionId: string): void;
  openProjectDialog(): void;
  closeProjectDialog(): void;
  defaultProjectsRoot(profileId: string): Promise<{ path: string }>;
  browseDirectory(profileId: string, path: string): ReturnType<FolderPickerActions["browse"]>;
  createProject(profileId: string, name: string, folderPath: string): Promise<void>;
  pickLocalFolder(defaultPath?: string): Promise<string | null>;
  updateProject(projectId: string, name: string, folderPath: string): Promise<string | undefined>;
  deleteProject(projectId: string): Promise<string | undefined>;
  createTask(title: string, brief: string | null): Promise<TaskCreateOutcome>;
  updateTask(taskId: string, title: string, brief: string | null): Promise<string | undefined>;
  bindTaskBranch(taskId: string, repositoryPath: string, branchName: string): Promise<string | undefined>;
  listProjectLocalBranches(projectId: string): Promise<ProjectLocalBranchListResult>;
  provisionTaskWorktree(params: TaskProvisionWorktreeParams): Promise<string | undefined>;
  dismissTaskWorktreeProvisioning(taskId: string, operationId: string): Promise<string | undefined>;
  inspectTaskWorktreeCleanup(taskId: string): Promise<TaskWorktreeCleanupPreviewDto>;
  cleanupTaskWorktree(params: TaskCleanupWorktreeParams): Promise<string | undefined>;
  listProjectWorktreeChanges(projectId: string): Promise<ProjectWorktreeChangeListResult>;
  getProjectWorktreeDiff(projectId: string, observationId: string, entryId: string): Promise<ProjectWorktreeDiffResult>;
  getProjectWorktreePreImage(projectId: string, observationId: string, entryId: string): Promise<ProjectWorktreePreImageResult>;
  listTaskWorktreeChanges(taskId: string): Promise<TaskWorktreeChangeListResult>;
  getTaskWorktreeDiff(taskId: string, observationId: string, entryId: string): Promise<TaskWorktreeDiffResult>;
  getTaskWorktreePreImage(taskId: string, observationId: string, entryId: string): Promise<TaskWorktreePreImageResult>;
  listTaskBranchCommits(taskId: string): Promise<TaskBranchCommitListResult>;
  listTaskBranchCommitChanges(taskId: string, observationId: string, commitId: string): Promise<TaskBranchCommitChangeListResult>;
  getTaskBranchCommitDiff(taskId: string, observationId: string, commitId: string, entryId: string): Promise<TaskBranchCommitDiffResult>;
  listTaskPullRequestChanges(taskId: string, expectedFreshnessGeneration: number, pullRequest: GitHostPullRequestIdentityDto): Promise<GitHostPullRequestChangeListResult>;
  getTaskPullRequestDiff(taskId: string, observationId: string, entryId: string): Promise<GitHostPullRequestDiffResult>;
  sendTaskReviewNotes(taskId: string, sessionId: string, message: string): Promise<string | undefined>;
  sendProjectReviewNotes(projectId: string, sessionId: string, message: string): Promise<string | undefined>;
  setTaskClosed(taskId: string, closed: boolean): Promise<void>;
  listArchivedTasks(projectId: string): Promise<Task[]>;
  inspectTaskArchive(taskId: string): Promise<TaskArchivePreviewDto>;
  archiveTask(taskId: string, archiveTicket: string): Promise<string | undefined>;
  restoreTask(taskId: string): Promise<string | undefined>;
  listArchivedSessions(projectId: string): Promise<Session[]>;
  listDeletedSessions(projectId: string): Promise<DeletedSessionDto[]>;
  archiveSession(sessionId: string): Promise<string | undefined>;
  restoreArchivedSession(sessionId: string): Promise<string | undefined>;
  deleteArchivedSession(sessionId: string): Promise<string | undefined>;
  restoreDeletedSession(sessionId: string): Promise<string | undefined>;
  deleteTaskAndWorktree(taskId: string, review?: TaskDeleteWorktreeReview): Promise<TaskDeleteWorktreeResult>;
  deleteArchivedTaskAndWorktree(task: Task, review?: TaskDeleteWorktreeReview): Promise<TaskDeleteWorktreeResult>;
  openExternal(url: string, runSessionId?: string): Promise<void>;
  copySessionId(sessionId: string): Promise<void>;
  launchTerminal(): Promise<void>;
  launchAgent(agentId: string): Promise<"configure" | undefined>;
  loadSessionHistory(projectId: string, force?: boolean, fillCache?: boolean): Promise<SessionHistoryListResult>;
  loadSessionHistoryPreview(projectId: string, sessionId: string): Promise<SessionHistoryPreviewResult>;
  resumeHistorySession(projectId: string, historyHandle: string): Promise<string | undefined>;
  pasteQuickActionImage(projectId: string): Promise<QuickActionImageHandle>;
  restoreQuickActionImage(attachmentId: string): Promise<QuickActionImageHandle>;
  discardQuickActionImage(attachmentId: string): Promise<void>;
  previewQuickAction(projectId: string, agentId: string, model: string, permission: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max", prompt: string, attachmentIds: string[]): Promise<QuickActionPreviewResult>;
  launchQuickAction(projectId: string, agentId: string, model: string, permission: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max", prompt: string, attachmentIds: string[], launchTicket: string): Promise<string | undefined>;
  launchTaskTerminal(taskId: string): Promise<string | undefined>;
  launchTaskAgent(taskId: string, agentId: string, model?: string, permission?: AgentCapabilityDto["permissions"][number], reasoning?: AgentCapabilityDto["reasoning"][number], kickoffMessage?: string): Promise<string | undefined>;
  runImprovement: RunImprovement;
  settingsImprovement: ConfigurationVersionActions & {
    start(target: SettingsImproverTarget, selection?: QuickActionAgentSelection, options?: { fresh?: boolean }): Promise<string | undefined>;
  };
  saveRunConfiguration(params: RunConfigurationCreateParams | RunConfigurationUpdateParams): Promise<RunConfigurationDto | string>;
  deleteRunConfiguration(configurationId: string): Promise<string | undefined>;
  launchTaskRun(taskId: string, configurationId: string, restart: boolean, forceSetup?: boolean): Promise<string | undefined>;
  launchProjectRun(projectId: string, configurationId: string, restart: boolean, forceSetup?: boolean): Promise<string | undefined>;
  inspectTaskWorktreeRepair(taskId: string, candidatePath: string): Promise<TaskWorktreeRepairPreviewDto>;
  repairTaskWorktree(params: TaskRepairWorktreeParams): Promise<string | undefined>;
  dismissTaskWorktreeRepair(taskId: string, operationId: string): Promise<string | undefined>;
  renameSession(sessionId: string, name: string | null): Promise<string | undefined>;
  forkSession(sessionId: string): Promise<boolean>;
  repairProviderHistory(sessionId: string): Promise<string | undefined>;
  requestAgentAskTo(sessionId: string, targetAgentId: "claude" | "codex"): Promise<void>;
  requestAgentHandoverTo(sessionId: string, targetSessionId: string): Promise<void>;
  dismissSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  restartAgent(sessionId: string): Promise<void>;
  previewSessionRelocation(sessionId: string, taskId: string, mode: "resume" | "fresh"): Promise<SessionRelocationPreviewDto>;
  relocateSession(sessionId: string, taskId: string, operationId: string, relocationTicket: string, mode: "resume" | "fresh", manifestDigest: string): Promise<boolean>;
  previewSessionProjectRelocation(sessionId: string, projectId: string): Promise<SessionRelocationPreviewDto>;
  relocateSessionToProject(sessionId: string, projectId: string, operationId: string, relocationTicket: string, manifestDigest: string): Promise<boolean>;
  closeSession(sessionId: string): Promise<void>;
  bindTerminalHost(sessionId: string, host: HTMLElement | null): void;
  setTerminalOccluded(occluded: boolean): void;
  subscribeNativeShellShortcut(listener: (shortcut: GhosttyShellShortcut) => void): () => void;
  setNativeOverlayOpen(open: boolean): void;
  overlayContainer: Element | undefined;
  openSessionInSplit(sessionId: string, direction: SplitDirection): void;
  openSessionInSplitAtPane(sessionId: string, paneId: string, direction: SplitDirection, placement: SplitPlacement): boolean;
  splitActivePane(direction: SplitDirection): void;
  focusPane(paneId: string): void;
  focusRelativePane(offset: -1 | 1): void;
  resizeLayoutSplit(splitId: string, ratio: number): void;
  closePane(paneId: string): void;
  clearPane(paneId: string): void;
  terminalResizeOwner(sessionId: string): boolean | undefined;
  reorderSession(sessionId: string, targetSessionId: string, placement: "before" | "after"): boolean;
  agentGroups: readonly AgentGroupLayout[];
  detachedRelationshipSessionIds?: ReadonlySet<string> | undefined;
  groupAgentSessions(sessionId: string, targetSessionId: string): boolean;
  renameAgentGroup(sessionId: string, name: string): boolean;
  ungroupAgentGroup(sessionId: string): boolean;
  detachAgentRelationship?(sessionId: string): boolean;
};

export function dismissChangesBeforeNavigation<T>(
  dismissChanges: () => void,
  navigate: (target: T) => void,
  target: T,
): void {
  dismissChanges();
  navigate(target);
}

/// A Session's terminal and the pages that replace it — Steward details, Task
/// details — all want the same stage, so opening one has to clear the others
/// before it navigates. Otherwise the Session becomes selected behind a page
/// that is still covering it.
export function openWorkspaceSession(
  dismissChanges: () => void,
  dismissStagePages: () => void,
  navigate: (sessionId: string) => void,
  sessionId: string,
  preserveStagePage = false,
): void {
  dismissChanges();
  if (!preserveStagePage) dismissStagePages();
  navigate(sessionId);
}

/// An improver chip lives inside an assistant page, but its destination is the
/// ordinary Session terminal. Unlike selecting that same Session again from
/// Workspace, this explicit terminal affordance must always replace the page
/// that currently covers the stage (for example, a Routine's step settings).
export function openImproverSession(
  dismissChanges: () => void,
  dismissStagePages: () => void,
  navigate: (sessionId: string) => void,
  sessionId: string,
): void {
  openWorkspaceSession(dismissChanges, dismissStagePages, navigate, sessionId);
}

/// Which list owns the sidebar. Skills, MCP, and Prompts are peers of the
/// Workspace rail rather than dialogs, so the tab row above them never moves.
export type RailMode = "workspace" | "skills" | "context" | "mcp" | "prompts";

/// The page currently covering the terminal stage, addressed by what it edits.
export type StagePage =
  | { kind: "skill"; id: string }
  | { kind: "contextFile"; id: string }
  | { kind: "mcpTool"; id: string }
  | { kind: "prompt"; id: string }
  | { kind: "taskSources" };

export function shellAssistantStageVisible(
  railMode: RailMode,
  workspaceView: WorkspaceView,
  selection: AssistantSelection | undefined,
): boolean {
  return railMode === "workspace" && workspaceView === "steward" && selection !== undefined;
}

export function shellTerminalOccluded(changesOpen: boolean, sidebarDragging: boolean, sessionDragging = false): boolean {
  // Ghostty is a native child view above Chromium. It must yield for the whole
  // Session drag or it can intercept a quick pointer path into a terminal pane
  // before the DOM drop target sees that pointer.
  return changesOpen || sidebarDragging || sessionDragging;
}

export function shellNativeOverlayOpen(state: {
  projectDialog: boolean;
  projectMenu: boolean;
  editProject: boolean;
  deleteProject: boolean;
  mobileConnect: boolean;
  connectionProfiles?: boolean;
  renameSession: boolean;
  commandPalette: boolean;
  shortcutSettings: boolean;
  quickAction: boolean;
  runEditor: boolean;
  sessionMenu: boolean;
  taskRelocation: boolean;
  projectRelocation: boolean;
  providerHistoryRepair: boolean;
  taskRail: boolean;
  archivedRail: boolean;
}): boolean {
  return Object.values(state).some(Boolean);
}

export function Shell(props: ShellProps) {
  const [renameSessionId, setRenameSessionId] = useState<string>();
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [editProjectOpen, setEditProjectOpen] = useState(false);
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false);
  /// "new" is the first-run offer; a configuration is the existing dev server
  /// opened for editing — the only Project-level way to reach its settings and
  /// its Improve-with-agent launcher.
  const [runEditor, setRunEditor] = useState<RunConfiguration | "new">();
  /// One page at a time replaces the terminal stage, so the settings editors
  /// share the single slot the Skill editor introduced.
  const [stagePage, setStagePage] = useState<StagePage>();
  const runEditorOpen = Boolean(runEditor);
  /// The named offer is a first-run affordance: once the Project can actually
  /// run a dev server, the same slot becomes the button that starts it in the
  /// Project's own checkout — the one the Project points at, not a worktree.
  const devServerRun = props.runConfigurations.find((configuration) => configuration.kind === "devServer");
  const projectRunSessionId = devServerRun && props.runRuntimes.find(
    (runtime) => runtime.taskId === null && runtime.configurationId === devServerRun.id,
  )?.sessionId;
  const projectRunLive = Boolean(
    projectRunSessionId
    && props.projectSessions.some((session) => session.id === projectRunSessionId && isLiveSession(session)),
  );
  const [mobileConnectOpen, setMobileConnectOpen] = useState(false);
  const [connectionProfilesOpen, setConnectionProfilesOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState>();
  const [relocationSessionId, setRelocationSessionId] = useState<string>();
  const [relocationTaskId, setRelocationTaskId] = useState<string>();
  const [relocationMode, setRelocationMode] = useState<"resume" | "fresh">();
  const [backgroundRelocations, setBackgroundRelocations] = useState<ReadonlyMap<string, BackgroundSessionRelocationIntent>>(new Map());
  const [projectRelocationSessionId, setProjectRelocationSessionId] = useState<string>();
  const [providerHistoryRepairSessionId, setProviderHistoryRepairSessionId] = useState<string>();
  const [provisionRequestedTaskId, setProvisionRequestedTaskId] = useState<string>();
  const backgroundRelocationIntents = useMemo(() => [...backgroundRelocations.values()], [backgroundRelocations]);
  const backgroundProvisioningTaskIds = useMemo(() => new Set(
    backgroundRelocationIntents.filter((intent) => intent.provisioning).map((intent) => intent.taskId),
  ), [backgroundRelocationIntents]);
  const finishBackgroundRelocation = useCallback((taskId: string) => {
    setBackgroundRelocations((current) => {
      if (!current.has(taskId)) return current;
      const next = new Map(current);
      next.delete(taskId);
      return next;
    });
  }, []);
  const reopenBackgroundRelocation = useCallback((intent: BackgroundSessionRelocationIntent) => {
    setRelocationSessionId(intent.sessionId);
    setRelocationTaskId(intent.taskId);
    setRelocationMode(intent.mode);
  }, []);
  const repairBackgroundRelocation = useCallback((sessionId: string) => {
    setProviderHistoryRepairSessionId(sessionId);
  }, []);
  const beginBackgroundRelocation = useCallback((
    sessionId: string,
    params: TaskProvisionWorktreeParams,
    mode: "resume" | "fresh",
  ) => {
    const intent: BackgroundSessionRelocationIntent = { sessionId, taskId: params.taskId, mode, provisioning: true };
    setBackgroundRelocations((current) => new Map(current).set(params.taskId, intent));
    setRelocationSessionId(undefined);
    setRelocationTaskId(undefined);
    setRelocationMode(undefined);
    void props.provisionTaskWorktree(params).then((failure) => {
      setBackgroundRelocations((current) => {
        const pending = current.get(params.taskId);
        if (!pending) return current;
        const next = new Map(current);
        if (failure) next.delete(params.taskId);
        else next.set(params.taskId, { ...pending, provisioning: false });
        return next;
      });
    }).catch(() => finishBackgroundRelocation(params.taskId));
  }, [finishBackgroundRelocation, props.provisionTaskWorktree]);
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth(window.innerWidth));
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [sessionDragging, setSessionDragging] = useState(false);
  const [changesPresentation, setChangesPresentation] = useState<
    | { kind: "task"; taskId: string; source: ChangesOpenSource }
    | { kind: "project" }
  >();
  // Coarse tick so the pet can let observed activity go stale instead of latching on it.
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutSettingsOpen, setShortcutSettingsOpen] = useState(false);
  const [quickActionOpen, setQuickActionOpen] = useState(false);
  const [quickActionAgent, setQuickActionAgent] = useState<string>();
  const [improverSetup, setImproverSetup] = useState<ImproverSetup>();
  const openPromptImproverSetup = useCallback((target: AssistantPromptImproverTarget) => {
    if (!props.selectedProject) return;
    setQuickActionOpen(false);
    setQuickActionAgent(undefined);
    setImproverSetup({ kind: "prompt", projectId: props.selectedProject.id, target });
  }, [props.selectedProject]);
  /// Improve-with-agent for one settings entry. The agent changes the entry
  /// itself, so this only picks which agent runs.
  const openSettingsImproverSetup = useCallback((target: SettingsImproverTarget, subject: string) => {
    if (!props.selectedProject) return;
    setImproverSetup({ kind: "settings", projectId: props.selectedProject.id, target, subject });
  }, [props.selectedProject]);
  const openRunImproverSetup = useCallback((projectId: string, target: RunConfigurationImproverTarget) => {
    setQuickActionOpen(false);
    setQuickActionAgent(undefined);
    setImproverSetup({ kind: "run", projectId, target });
  }, []);
  const [railMode, setRailMode] = useState<RailMode>("workspace");
  const [contextBankRefreshToken, setContextBankRefreshToken] = useState(0);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("agents");
  const [activeAgentFavorites, setActiveAgentFavorites] = useState(readActiveAgentFavorites);
  const [activeAgentActivityMemory, setActiveAgentActivityMemory] = useState(readActiveAgentActivityMemory);
  const [assistantSelection, setAssistantSelection] = useState<AssistantSelection>();
  /// The Task whose detail page has the stage. Held by ID rather than by value
  /// so the page follows the live projection instead of a snapshot taken at the
  /// click, and drops itself when the Task leaves the Project.
  const [detailTaskId, setDetailTaskId] = useState<string>();
  const [taskRailOverlayOpen, setTaskRailOverlayOpen] = useState(false);
  /// Tab-bar state for the two rails that lost their title rows: the Agents
  /// search toggle and the Tasks create request both live beside the tabs.
  const [agentSearchOpen, setAgentSearchOpen] = useState(false);
  const [taskCreateRequested, setTaskCreateRequested] = useState(false);
  useEffect(() => {
    if (railMode !== "workspace" || workspaceView !== "agents") setAgentSearchOpen(false);
  }, [railMode, workspaceView]);
  const [archivedRailOverlayOpen, setArchivedRailOverlayOpen] = useState(false);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const commandInvokerRef = useRef<HTMLElement | null>(null);
  const commandsRef = useRef<readonly ShellCommand[]>([]);
  const projectsRef = useRef<readonly Project[]>([]);
  const selectProjectRef = useRef(props.selectProject);
  const doubleShiftRef = useRef(new DoubleShiftDetector());
  const platform = useMemo(() => keyboardPlatform(navigator.userAgent), []);
  const sessionsById = useMemo(() => new Map(props.projectSessions.map((session) => [session.id, session])), [props.projectSessions]);
  const statusesById = useMemo(() => new Map(props.agentStatuses.map((status) => [status.sessionId, status])), [props.agentStatuses]);
  useEffect(() => {
    const projectId = props.selectedProject?.id;
    if (!projectId) return;
    setActiveAgentActivityMemory((current) => {
      const next = updateActiveAgentActivityMemory(current, projectId, props.projectSessions, props.agentStatuses);
      if (next === current) return current;
      writeActiveAgentActivityMemory(next);
      return next;
    });
  }, [props.agentStatuses, props.projectSessions, props.selectedProject?.id]);
  const rememberedAgentActivityBySessionId = useMemo(
    () => new Map(Object.entries(props.selectedProject ? activeAgentActivityMemory[props.selectedProject.id] ?? {} : {})),
    [activeAgentActivityMemory, props.selectedProject?.id],
  );
  const favoriteAgentSessionIds = useMemo(
    () => new Set(props.selectedProject ? activeAgentFavorites[props.selectedProject.id] ?? [] : []),
    [activeAgentFavorites, props.selectedProject?.id],
  );
  const activeAgentAttentionCount = useMemo(
    () => props.projectSessions.filter((session) => session.kind === "Agent"
      && isLiveSession(session)
      && !isAssistantSession(session)
      && agentActivityPriority(
        session,
        statusesById.get(session.id),
        props.reviewReadySessionIds.has(session.id),
      ) <= 1).length,
    [props.projectSessions, props.reviewReadySessionIds, statusesById],
  );
  const toggleFavoriteAgentSession = useCallback((sessionId: string) => {
    const projectId = props.selectedProject?.id;
    if (!projectId) return;
    setActiveAgentFavorites(persistActiveAgentFavoriteToggle(activeAgentFavorites, projectId, sessionId));
  }, [activeAgentFavorites, props.selectedProject?.id]);
  const attachedSessionIds = useMemo(
    () => taskAttachedSessionIds(props.projectTasks, sessionsById),
    [props.projectTasks, sessionsById],
  );
  /// The waiting agents that sit inside a Task, for the Tasks tab's marker.
  const taskAttentionCount = useMemo(
    () => props.projectSessions.filter((session) => session.kind === "Agent"
      && isLiveSession(session)
      && attachedSessionIds.has(session.id)
      && agentActivityPriority(
        session,
        statusesById.get(session.id),
        props.reviewReadySessionIds.has(session.id),
      ) <= 1).length,
    [attachedSessionIds, props.projectSessions, props.reviewReadySessionIds, statusesById],
  );
  const worktreeChangesBySessionId = useMemo(() => {
    const changes = new Map<string, { taskId: string; taskTitle: string; changeCount: number }>();
    for (const task of props.projectTasks) {
      const changeCount = task.worktree_health?.change_count;
      if (!task.worktree || changeCount === null || changeCount === undefined || changeCount < 0) continue;
      for (const sessionId of taskAttachedSessionIds([task], sessionsById)) {
        changes.set(sessionId, { taskId: task.id, taskTitle: task.title, changeCount });
      }
    }
    return changes;
  }, [props.projectTasks, sessionsById]);
  const taskNestedHelperIds = useMemo(
    () => askToHelpersForSources(attachedSessionIds, sessionsById),
    [attachedSessionIds, sessionsById],
  );
  const looseSessions = useMemo(
    () => props.projectSessions.filter((session) => !attachedSessionIds.has(session.id) && !taskNestedHelperIds.has(session.id) && !isAssistantSession(session)),
    [attachedSessionIds, props.projectSessions, taskNestedHelperIds],
  );
  const agentGroupScopeBySessionId = useMemo(() => {
    const scopes = new Map(props.projectSessions.map((session) => [session.id, "project"]));
    for (const task of props.projectTasks) {
      for (const sessionId of taskAttachedSessionIds([task], sessionsById)) {
        scopes.set(sessionId, `task:${task.id}`);
      }
    }
    return scopes;
  }, [props.projectSessions, props.projectTasks, sessionsById]);
  const scopedAgentGroups = useMemo(() => props.agentGroups.filter((group) => {
    const scope = group.sessionIds[0] ? agentGroupScopeBySessionId.get(group.sessionIds[0]) : undefined;
    return scope !== undefined && group.sessionIds.every((sessionId) => agentGroupScopeBySessionId.get(sessionId) === scope);
  }), [agentGroupScopeBySessionId, props.agentGroups]);
  const groupAgentSessionsWithinScope = useCallback((sessionId: string, targetSessionId: string) => {
    const sourceScope = agentGroupScopeBySessionId.get(sessionId);
    return sourceScope !== undefined
      && sourceScope === agentGroupScopeBySessionId.get(targetSessionId)
      && props.groupAgentSessions(sessionId, targetSessionId);
  }, [agentGroupScopeBySessionId, props.groupAgentSessions]);
  const openSessionMenu = useCallback(
    (sessionId: string, x: number, y: number, invoker: HTMLElement) => setSessionMenu({ sessionId, x, y, invoker }),
    [],
  );
  const dismissSession = useCallback((sessionId: string) => { void props.dismissSession(sessionId); }, [props.dismissSession]);
  const menuSession = sessionMenu ? sessionsById.get(sessionMenu.sessionId) : undefined;
  const layoutPanes = useMemo(() => props.layout ? panes(props.layout) : [], [props.layout]);
  const renameTarget = renameSessionId ? sessionsById.get(renameSessionId) : undefined;
  const relocationSession = relocationSessionId ? sessionsById.get(relocationSessionId) : undefined;
  const projectRelocationSession = projectRelocationSessionId ? sessionsById.get(projectRelocationSessionId) : undefined;
  const providerHistoryRepairSession = providerHistoryRepairSessionId
    ? sessionsById.get(providerHistoryRepairSessionId)
    : undefined;
  const projectSourceGroups = useMemo(() => {
    const groups = new Map<string, { name: string; projects: Project[] }>();
    for (const project of props.projects) {
      const profileId = project.connectionProfileId ?? "local";
      const group = groups.get(profileId) ?? {
        name: project.connectionProfileName ?? "This computer",
        projects: [],
      };
      group.projects.push(project);
      groups.set(profileId, group);
    }
    return [...groups.entries()].map(([profileId, group]) => ({ profileId, ...group }));
  }, [props.projects]);
  const showProjectSourceGroups = projectSourceGroups.length > 1
    || projectSourceGroups.some((group) => group.profileId !== "local");
  const changesTask = changesPresentation?.kind === "task"
    ? props.projectTasks.find((task) => task.id === changesPresentation.taskId)
    : undefined;
  const changesProject = changesPresentation?.kind === "project" ? props.selectedProject : undefined;
  const changesSubject: ChangesSubject | undefined = changesTask ? {
    id: changesTask.id,
    title: changesTask.title,
    branchName: changesTask.branch?.name,
    kind: "task",
    hasWorktree: Boolean(changesTask.worktree),
    hasBranch: Boolean(changesTask.branch),
  } : changesProject ? {
    id: changesProject.id,
    title: changesProject.name,
    branchName: props.projectWorktreeSummary?.checked_out_branch ?? undefined,
    kind: "project",
    hasWorktree: true,
    hasBranch: false,
  } : undefined;
  const changesGitHostProjection = changesTask
    ? props.gitHostProjections.find((projection) => projection.task_id === changesTask.id)
    : undefined;
  const changesAgentSessions = useMemo(
    () => changesTask
      ? taskReviewAgentSessions(changesTask, props.projectSessions)
      : changesProject
        ? looseSessions.filter((session) => session.kind === "Agent" && isLiveSession(session))
        : [],
    [changesProject, changesTask, looseSessions, props.projectSessions],
  );
  const dismissChanges = useCallback(() => setChangesPresentation(undefined), []);
  const dismissStagePages = useCallback(() => {
    setAssistantSelection(undefined);
    setDetailTaskId(undefined);
    setStagePage(undefined);
  }, []);
  const detailTask = detailTaskId
    ? props.projectTasks.find((task) => task.id === detailTaskId)
    : undefined;
  const openTaskDetail = useCallback(
    (taskId: string) => {
      dismissChanges();
      setAssistantSelection(undefined);
      setStagePage(undefined);
      setDetailTaskId(taskId);
    },
    [dismissChanges],
  );
  const openStagePage = useCallback(
    (page: StagePage) => {
      dismissChanges();
      setAssistantSelection(undefined);
      setDetailTaskId(undefined);
      setStagePage(page);
    },
    [dismissChanges],
  );
  const detailSessions = useMemo(
    () => detailTask ? taskSessions(detailTask, sessionsById) : [],
    [detailTask, sessionsById],
  );
  const selectProject = useCallback(
    (projectId: string) => dismissChangesBeforeNavigation(dismissChanges, props.selectProject, projectId),
    [dismissChanges, props.selectProject],
  );
  const selectSession = useCallback(
    (sessionId: string) => openWorkspaceSession(
      dismissChanges,
      dismissStagePages,
      props.selectSession,
      sessionId,
      Boolean(assistantSelection && props.selectedSession?.id === sessionId),
    ),
    [assistantSelection, dismissChanges, dismissStagePages, props.selectSession, props.selectedSession?.id],
  );
  /// Only an Agent inside a Task worktree offers a dev server from its own
  /// menu, and it runs in that worktree. An Agent in the Project checkout has
  /// the rail's own Run button for exactly that checkout, so repeating the
  /// offer here would only invite starting a server against source the user is
  /// not looking at. A run already live in the worktree is opened rather than
  /// started twice.
  const menuRunDevServer = useMemo((): SessionRunDevServer | undefined => {
    if (!menuSession || !devServerRun) return undefined;
    if (menuSession.kind !== "Agent" || isAssistantSession(menuSession)) return undefined;
    const task = props.projectTasks.find(
      (candidate) => candidate.worktree && taskAttachedSessionIds([candidate], sessionsById).has(menuSession.id),
    );
    if (!task) return undefined;
    const runSessionId = props.runRuntimes.find(
      (runtime) => runtime.taskId === task.id && runtime.configurationId === devServerRun.id,
    )?.sessionId;
    const running = Boolean(
      runSessionId && props.projectSessions.some((session) => session.id === runSessionId && isLiveSession(session)),
    );
    return {
      name: devServerRun.name,
      running,
      start: () => {
        if (running && runSessionId) {
          selectSession(runSessionId);
          return;
        }
        void props.launchTaskRun(task.id, devServerRun.id, false);
      },
    };
  }, [devServerRun, menuSession, props.launchTaskRun, props.projectSessions, props.projectTasks, props.runRuntimes, selectSession, sessionsById]);
  const menuAgentActions = useMemo((): SessionAgentActions | undefined => {
    if (!menuSession
      || menuSession.kind !== "Agent"
      || menuSession.lifecycle_state !== "running"
      || !matchesInteractiveAgentProvider(menuSession)
      || !props.agentCapabilities.some((capability) => capability.agent_id === menuSession.process.agent_id
        && capability.quick_action_supported)
      || isAssistantSession(menuSession)
      || sessionIsImprover(menuSession)
      || menuSession.run_configuration_id !== null) {
      return undefined;
    }
    const askTargets = props.agentCapabilities
      .filter((capability): capability is AgentCapabilityDto & { agent_id: "claude" | "codex" } =>
        capability.available
        && capability.tracked_helpers_supported
        && (capability.agent_id === "claude" || capability.agent_id === "codex"))
      .map((capability) => ({
        agentId: capability.agent_id,
        label: capability.agent_id === "claude" ? "Claude" : "Codex",
      }));
    const handoverTargets = props.projectSessions.filter((candidate) =>
      candidate.id !== menuSession.id
      && candidate.kind === "Agent"
      && candidate.lifecycle_state === "running"
      && matchesInteractiveAgentProvider(candidate)
      && props.agentCapabilities.some((capability) => capability.agent_id === candidate.process.agent_id
        && capability.quick_action_supported)
      && !isAssistantSession(candidate)
      && !sessionIsImprover(candidate)
      && candidate.run_configuration_id === null);
    return {
      askTargets,
      handoverTargets,
      askTo: (agentId) => { void props.requestAgentAskTo(menuSession.id, agentId); },
      handoverTo: (targetSessionId) => { void props.requestAgentHandoverTo(menuSession.id, targetSessionId); },
    };
  }, [menuSession, props.agentCapabilities, props.projectSessions, props.requestAgentAskTo, props.requestAgentHandoverTo]);
  const retrySession = useCallback((sessionId: string) => {
    // Put the preserved terminal on screen before handing its PTY from the
    // continuation shell back to the provider. This makes the actual Claude
    // or Codex retry output visible even when Retry was clicked on another row.
    selectSession(sessionId);
    requestAnimationFrame(() => { void props.resumeSession(sessionId); });
  }, [props.resumeSession, selectSession]);
  const navigateSession = useCallback(
    (sessionId: string) => openWorkspaceSession(
      dismissChanges,
      dismissStagePages,
      props.navigateSession,
      sessionId,
    ),
    [dismissChanges, dismissStagePages, props.navigateSession],
  );
  const selectAssistantSession = useCallback(
    (sessionId: string) => dismissChangesBeforeNavigation(dismissChanges, props.selectSession, sessionId),
    [dismissChanges, props.selectSession],
  );
  const openImproverTerminal = useCallback(
    (sessionId: string) => openImproverSession(
      dismissChanges,
      dismissStagePages,
      props.selectSession,
      sessionId,
    ),
    [dismissChanges, dismissStagePages, props.selectSession],
  );
  /// Opening any assistant detail implies the Steward view has the rail; every
  /// entry point (rail rows, pet, draft reveal) shares this one reveal.
  const openAssistant = useCallback(
    (selection: AssistantSelection) => {
      setRailMode("workspace");
      setWorkspaceView("steward");
      setDetailTaskId(undefined);
      setStagePage(undefined);
      dismissChangesBeforeNavigation(dismissChanges, setAssistantSelection, selection);
    },
    [dismissChanges],
  );
  const toggleRail = useCallback(
    (mode: Exclude<RailMode, "workspace">) => setRailMode((current) => current === mode ? "workspace" : mode),
    [],
  );
  const revealStewardRail = useCallback(() => {
    setRailMode("workspace");
    setWorkspaceView("steward");
  }, []);
  const selectWorkspaceView = useCallback((view: WorkspaceView) => {
    setRailMode("workspace");
    setWorkspaceView(view);
    if (view === "steward" && !assistantSelection && props.selectedProject) {
      openAssistant({ kind: "steward" });
    }
  }, [assistantSelection, openAssistant, props.selectedProject]);
  const assistantStageVisible = shellAssistantStageVisible(railMode, workspaceView, assistantSelection);
  const mcpLibrary = useSettingsLibrary(
    props.loadMcpToolSettings,
    railMode === "mcp" || stagePage?.kind === "mcpTool",
  );
  const promptLibrary = useSettingsLibrary(
    props.loadPromptAssets,
    railMode === "prompts" || stagePage?.kind === "prompt",
  );
  const stageMcpTool = stagePage?.kind === "mcpTool"
    ? mcpLibrary.value?.tools.find((tool) => tool.name === stagePage.id)
    : undefined;
  const stagePrompt = stagePage?.kind === "prompt"
    ? promptLibrary.value?.find((prompt) => prompt.id === stagePage.id)
    : undefined;
  const improvePrompt = useCallback((prompt: PromptAsset) => {
    const target = promptImproveTarget(prompt);
    if (!target || !props.selectedProject) return;
    if (target.kind === "assistant") {
      openPromptImproverSetup({ surface: target.surface, ownerId: target.ownerId });
      return;
    }
    openSettingsImproverSetup(
      { kind: "prompt", id: target.id, name: target.name, path: target.path, content: target.content },
      `${target.name} prompt`,
    );
  }, [openPromptImproverSetup, openSettingsImproverSetup, props.selectedProject]);
  const openPromptPage = useCallback(
    (promptId: string) => {
      setRailMode("prompts");
      openStagePage({ kind: "prompt", id: promptId });
    },
    [openStagePage],
  );
  const openPlaybookBuilder = useCallback(() => {
    openAssistant({ kind: "steward", initialView: "builder" });
  }, [openAssistant]);
  useEffect(() => {
    if (props.connection !== "connected") setChangesPresentation(undefined);
  }, [props.connection]);
  useEffect(() => { setChangesPresentation(undefined); }, [props.selectedProject?.id]);
  useEffect(() => {
    setAssistantSelection(undefined);
    setDetailTaskId(undefined);
    setImproverSetup(undefined);
  }, [props.selectedProject?.id]);
  const selectedSourceOffline = props.selectedProject?.connectionState === "offline";
  const selectedConnectionProfileId = props.selectedProject?.connectionProfileId ?? "local";
  const disabled = !props.selectedProject || props.connection !== "connected" || selectedSourceOffline;
  const archived = useArchivedTasks({
    projectId: props.selectedProject?.id,
    activeTaskCount: props.projectTasks.length,
    list: props.listArchivedTasks,
    listSessions: props.listArchivedSessions,
    restore: props.restoreTask,
    restoreSession: props.restoreArchivedSession,
  });
  const deleted = useDeletedSessions({
    projectId: props.selectedProject?.id,
    activeSessionCount: props.projectSessions.length,
    list: props.listDeletedSessions,
    restore: props.restoreDeletedSession,
  });
  const projectActionDisabled = !props.selectedProject || props.connection !== "connected" || selectedSourceOffline;
  const shortcutsBlocked = mobileConnectOpen || connectionProfilesOpen || shellShortcutsBlocked({
    projectDialogOpen: props.projectDialogOpen,
    projectMenuOpen,
    editProjectOpen,
    deleteProjectOpen,
    renameSessionOpen: Boolean(renameTarget),
    shortcutSettingsOpen,
    quickActionOpen: quickActionOpen || Boolean(improverSetup),
    runEditorOpen,
    changesEditorOpen: Boolean(changesSubject),
  });
  const nativeOverlayOpen = shellNativeOverlayOpen({
    projectDialog: props.projectDialogOpen,
    projectMenu: projectMenuOpen,
    editProject: editProjectOpen,
    deleteProject: deleteProjectOpen,
    mobileConnect: mobileConnectOpen,
    connectionProfiles: connectionProfilesOpen,
    renameSession: Boolean(renameTarget),
    commandPalette: commandPaletteOpen,
    shortcutSettings: shortcutSettingsOpen,
    quickAction: quickActionOpen || Boolean(improverSetup),
    runEditor: runEditorOpen,
    sessionMenu: Boolean(sessionMenu),
    taskRelocation: Boolean(relocationSession),
    projectRelocation: Boolean(projectRelocationSession),
    providerHistoryRepair: Boolean(providerHistoryRepairSession),
    taskRail: taskRailOverlayOpen,
    archivedRail: archivedRailOverlayOpen,
  });
  useEffect(() => {
    props.setNativeOverlayOpen(nativeOverlayOpen);
    return () => props.setNativeOverlayOpen(false);
  }, [nativeOverlayOpen, props.setNativeOverlayOpen]);
  useEffect(() => {
    props.setTerminalOccluded(shellTerminalOccluded(Boolean(changesSubject), sidebarDragging, sessionDragging));
    return () => props.setTerminalOccluded(false);
  }, [changesSubject, props.setTerminalOccluded, sessionDragging, sidebarDragging]);
  const resizeSidebar = useCallback((width: number) => {
    const next = clampSidebarWidth(width, window.innerWidth);
    setSidebarWidth(next);
    writeSidebarWidth(next);
  }, []);
  useEffect(() => {
    const fitSidebarToViewport = () => {
      setSidebarWidth((current) => clampSidebarWidth(current, window.innerWidth));
    };
    window.addEventListener("resize", fitSidebarToViewport);
    return () => window.removeEventListener("resize", fitSidebarToViewport);
  }, []);
  const appShellStyle = { "--sidebar-width": `${sidebarWidth}px` } as CSSProperties;
  const projectTriggerBounds = projectMenuOpen ? projectTriggerRef.current?.getBoundingClientRect() : undefined;
  const projectMenuStyle = projectTriggerBounds
    ? {
      position: "fixed",
      top: `${projectTriggerBounds.bottom - 4}px`,
      left: `${projectTriggerBounds.left}px`,
      right: "auto",
      width: `${projectTriggerBounds.width}px`,
    } as CSSProperties
    : undefined;

  const openCommandPalette = useCallback(() => {
    commandInvokerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCommandPaletteOpen(true);
  }, []);
  const closeCommandPalette = useCallback(() => {
    setCommandPaletteOpen(false);
    const invoker = commandInvokerRef.current;
    commandInvokerRef.current = null;
    requestAnimationFrame(() => invoker?.focus());
  }, []);
  const openQuickAction = useCallback((agentId?: string) => {
    setQuickActionAgent(agentId);
    setQuickActionOpen(true);
  }, []);
  const launchOrConfigureAgent = useCallback(async (agentId: string) => {
    if (await props.launchAgent(agentId) === "configure") openQuickAction(agentId);
  }, [openQuickAction, props.launchAgent]);
  const commands: ShellCommand[] = [
    {
      id: "launch.quickAction", title: "Open Quick Action", detail: "Compose a versioned prompt for an agent.", group: "Launch", keywords: ["shift", "prompt", "model"],
      disabled, perform: () => openQuickAction(),
    },
    {
      id: "project.add", title: "Add Project", detail: "Add a local folder to TermLoop.", group: "Project", keywords: ["new", "folder"],
      perform: props.openProjectDialog,
    },
    ...props.projects.map((project, index): ShellCommand => {
      const hint = projectShortcutLabel(index, platform);
      return {
        id: `project.switch.${project.id}`,
        title: `Switch to ${project.name}`,
        detail: project.id === props.selectedProject?.id
          ? `Current Project${project.connectionProfileName ? ` · ${project.connectionProfileName}` : ""}`
          : `${project.connectionProfileName ? `${project.connectionProfileName} · ` : ""}${project.folder_path}`,
        group: "Project",
        keywords: ["project", "switch", project.folder_path],
        ...(hint ? { shortcutHint: hint } : {}),
        perform: () => selectProject(project.id),
      };
    }),
    {
      id: "launch.terminal", title: "New Terminal", detail: "Launch in the selected Project.", group: "Launch", keywords: ["shell", "session"], shortcutId: "newTerminal",
      disabled, perform: props.launchTerminal,
    },
    {
      id: "launch.claude", title: "New Claude Session", detail: "Launch Claude in the selected Project.", group: "Launch", keywords: ["agent"],
      disabled, perform: () => launchOrConfigureAgent("claude"),
    },
    {
      id: "launch.codex", title: "New Codex Session", detail: "Launch Codex in the selected Project.", group: "Launch", keywords: ["agent"],
      disabled, perform: () => launchOrConfigureAgent("codex"),
    },
    {
      id: "view.history", title: "Session History", detail: "Open inactive TermLoop Agents and local Claude or Codex conversations.", group: "Session", keywords: ["resume", "vault", "past"],
      disabled: !props.selectedProject, perform: () => selectWorkspaceView("history"),
    },
    {
      id: "view.taskSources", title: "Tasks", detail: "What a new Task starts with, the Jira sources, and the issues waiting to import.", group: "Session", keywords: ["jira", "import", "issues", "sync", "worktree", "automation"],
      disabled: !props.selectedProject, perform: () => openStagePage({ kind: "taskSources" }),
    },
    ...props.projectSessions.map((session): ShellCommand => ({
      id: `session.focus.${session.id}`,
      title: `Focus ${sessionLabel(session)}`,
      detail: `${session.kind} · ${session.process.cwd}`,
      group: "Session",
      keywords: ["open", "navigate", session.process.agent_id ?? ""],
      perform: () => selectSession(session.id),
    })),
    {
      id: "session.dismiss",
      title: props.selectedSession && sessionDismissCommand(props.selectedSession) === "close" ? "Remove Selected Session" : "Close Selected Session",
      detail: props.selectedSession ? `${sessionLabel(props.selectedSession)} · ${sessionDismissCommand(props.selectedSession) === "close" ? "Remove its stopped descriptor." : "End its process and remove the Session."}` : "Select a Session first.",
      group: "Session",
      keywords: ["stop", "close", "remove"],
      disabled: !props.selectedSession || !sessionDismissCommand(props.selectedSession),
      danger: true,
      perform: () => { if (props.selectedSession) void props.dismissSession(props.selectedSession.id); },
    },
    {
      id: "layout.splitRight", title: "Split Pane Right", detail: "Create an empty pane beside the active pane.", group: "Layout", keywords: ["horizontal"],
      disabled: !props.layout || layoutPanes.length >= MAX_LAYOUT_PANES, perform: () => props.splitActivePane("horizontal"),
    },
    {
      id: "layout.splitDown", title: "Split Pane Down", detail: "Create an empty pane below the active pane.", group: "Layout", keywords: ["vertical"],
      disabled: !props.layout || layoutPanes.length >= MAX_LAYOUT_PANES, perform: () => props.splitActivePane("vertical"),
    },
    {
      id: "layout.focusPrevious", title: "Focus Previous Pane", detail: "Cycle focus without detaching a Session.", group: "Layout", shortcutId: "focusPreviousPane",
      disabled: layoutPanes.length < 2, perform: () => props.focusRelativePane(-1),
    },
    {
      id: "layout.focusNext", title: "Focus Next Pane", detail: "Cycle focus without detaching a Session.", group: "Layout", shortcutId: "focusNextPane",
      disabled: layoutPanes.length < 2, perform: () => props.focusRelativePane(1),
    },
    {
      id: "layout.detach", title: "Detach Active Pane", detail: "Close the pane; its Session keeps running.", group: "Layout", keywords: ["close"],
      disabled: !props.layout, perform: () => { if (props.layout) props.closePane(props.layout.activePaneId); },
    },
    {
      id: "settings.keyboard", title: "Settings: Keyboard Shortcuts", detail: "Review shell-level shortcuts and focus behavior.", group: "Settings", keywords: ["keys", "hotkey"],
      perform: () => setShortcutSettingsOpen(true),
    },
  ];
  commandsRef.current = commands;
  projectsRef.current = props.projects;
  selectProjectRef.current = selectProject;

  useEffect(() => {
    const shortcutIds: readonly ShellShortcutId[] = ["newTerminal", "focusPreviousPane", "focusNextPane"];
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (matchesShellShortcut(event, "commandPalette", platform)) {
        if (shortcutsBlocked) { doubleShiftRef.current.reset(); return; }
        event.preventDefault();
        if (commandPaletteOpen) closeCommandPalette(); else openCommandPalette();
        return;
      }
      if (!shortcutsBlocked && !commandPaletteOpen && doubleShiftRef.current.keyDown(event)) {
        openQuickAction();
        return;
      }
      if (shortcutsBlocked || commandPaletteOpen) {
        doubleShiftRef.current.reset();
        return;
      }
      const projectIndex = projectShortcutIndex(event, platform);
      if (projectIndex !== undefined) {
        const project = projectsRef.current[projectIndex];
        if (!project) return;
        event.preventDefault();
        selectProjectRef.current(project.id);
        return;
      }
      const shortcutId = shortcutIds.find((candidate) => matchesShellShortcut(event, candidate, platform));
      const command = shortcutId ? commandsRef.current.find((candidate) => candidate.shortcutId === shortcutId) : undefined;
      if (!command || command.disabled) return;
      event.preventDefault();
      void command.perform();
    };
    const keyUp = (event: KeyboardEvent) => doubleShiftRef.current.keyUp(event);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [shortcutsBlocked, closeCommandPalette, commandPaletteOpen, openCommandPalette, openQuickAction, platform]);
  useEffect(() => props.subscribeNativeShellShortcut((shortcut) => {
    doubleShiftRef.current.reset();
    if (shortcut === "quickAction") {
      if (!shortcutsBlocked && !commandPaletteOpen) openQuickAction();
      return;
    }
    if (shortcut === "commandPalette") {
      if (shortcutsBlocked) return;
      if (commandPaletteOpen) closeCommandPalette(); else openCommandPalette();
      return;
    }
    if (shortcutsBlocked || commandPaletteOpen) return;
    const projectIndex = nativeProjectShortcutIndex(shortcut);
    if (projectIndex !== undefined) {
      const project = projectsRef.current[projectIndex];
      if (project) selectProjectRef.current(project.id);
      return;
    }
    const shortcutId = nativeShellCommandId(shortcut);
    const command = shortcutId
      ? commandsRef.current.find((candidate) => candidate.shortcutId === shortcutId)
      : undefined;
    if (!command || command.disabled) return;
    void command.perform();
  }), [shortcutsBlocked, closeCommandPalette, commandPaletteOpen, openCommandPalette, openQuickAction, props.subscribeNativeShellShortcut]);
  useEffect(() => {
    setRenameSessionId(undefined);
    setProjectMenuOpen(false);
    setEditProjectOpen(false);
    setDeleteProjectOpen(false);
    setSessionMenu(undefined);
    setChangesPresentation(undefined);
    setBackgroundRelocations(new Map());
    setProvisionRequestedTaskId(undefined);
  }, [props.selectedProject?.id]);
  useEffect(() => {
    if (changesPresentation?.kind === "task" && !changesTask) setChangesPresentation(undefined);
  }, [changesPresentation, changesTask]);
  useEffect(() => { if (sessionMenu && !menuSession) setSessionMenu(undefined); }, [sessionMenu, menuSession]);
  useEffect(() => {
    if (!projectMenuOpen) return;
    requestAnimationFrame(() => {
      const selected = projectMenuRef.current?.querySelector<HTMLButtonElement>('[data-project-selected="true"]');
      (selected ?? projectMenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'))?.focus();
    });
  }, [projectMenuOpen]);

  const closeSessionPane = (sessionId: string) => {
    const pane = layoutPanes.find((candidate) => candidate.sessionId === sessionId);
    if (pane) props.closePane(pane.id);
  };

  const closeProjectMenu = (restoreFocus = false) => {
    setProjectMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => projectTriggerRef.current?.focus());
  };
  const handleProjectMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeProjectMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (current + 1) % items.length
          : (current <= 0 ? items.length : current) - 1;
    items[next]?.focus();
  };

  const assistantProjectId = props.selectedProject?.id;
  const connectionTitle = props.connectionMessage?.startsWith("Version mismatch:")
    ? "Server version mismatch"
    : props.connection === "daemonUnavailable"
      ? "Server unavailable"
      : props.connection === "connecting"
        ? "Connecting to server…"
        : "Server connection lost";
  return (
    <>
      {props.connection !== "connected" ? <div className="server-connection-alert" role="status">
        <div><strong>{connectionTitle}</strong><span>{props.connectionMessage ?? "TermLoop will keep retrying in the background."}</span></div>
        <button type="button" onClick={() => setConnectionProfilesOpen(true)}>Servers</button>
      </div> : null}
      <SidebarSessionDndProvider
        sessions={props.projectSessions.filter((session) => !isAssistantSession(session))}
        reorderSession={props.reorderSession}
        groupAgentSessions={groupAgentSessionsWithinScope}
        requestTaskRelocation={(sessionId, taskId) => {
          const targetTask = props.projectTasks.find((task) => task.id === taskId);
          if (!sessionsById.has(sessionId) || !targetTask) return false;
          /// The Session's own Task is not a destination; relocating in
          /// place would only restart the Agent in the same worktree.
          if (taskAttachedSessionIds([targetTask], sessionsById).has(sessionId)) return false;
          setRelocationSessionId(sessionId);
          setRelocationTaskId(taskId);
          setRelocationMode(undefined);
          return true;
        }}
        requestProjectRelocation={(sessionId) => {
          if (!attachedSessionIds.has(sessionId)) return false;
          setProjectRelocationSessionId(sessionId);
          return true;
        }}
        requestSplit={props.openSessionInSplitAtPane}
        draggingChanged={setSessionDragging}
      >
      <div className="app-shell" style={appShellStyle}>
        <aside className="sidebar" aria-label="Projects and sessions">
          {showsWindowDragRegion(platform) && <div className="window-drag-region" aria-hidden="true" />}
          <header className="brand-row">
            <div className="brand-cluster">
              <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /></span><strong>TermLoop</strong></div>
              <button className="mcp-settings-trigger" type="button" aria-pressed={railMode === "mcp"} onClick={() => toggleRail("mcp")}><span aria-hidden="true" /><strong>MCP</strong></button>
              <button className="prompt-settings-trigger" type="button" aria-pressed={railMode === "prompts"} onClick={() => toggleRail("prompts")}><span aria-hidden="true" /><strong>Prompts</strong></button>
              <button className="skill-settings-trigger" type="button" aria-pressed={railMode === "skills"} onClick={() => toggleRail("skills")}><span aria-hidden="true" /><strong>Skills</strong></button>
              <button className="context-settings-trigger" type="button" aria-pressed={railMode === "context"} onClick={() => toggleRail("context")}><span aria-hidden="true" /><strong>Context</strong></button>
            </div>
            <div className="brand-actions"><button className="icon-button quiet" title="Command palette" aria-label="Open command palette" aria-keyshortcuts="Control+Shift+P Meta+Shift+P" onClick={openCommandPalette}><Icon name="search" /></button><button className="icon-button quiet" title="Add Project" aria-label="Add Project" onClick={props.openProjectDialog}><Icon name="add" /></button></div>
          </header>
          <ProjectCheckoutHeader
            {...(props.selectedProject
              ? { changes: { summary: props.projectWorktreeSummary, open: () => setChangesPresentation({ kind: "project" }) } }
              : {})}
          >
            <div className={`project-trigger-row${selectedSourceOffline ? " with-refresh" : ""}`}>
              <button
                ref={projectTriggerRef}
                id="project"
                className="project-trigger"
                type="button"
                aria-label="Current Project"
                aria-haspopup="menu"
                aria-expanded={projectMenuOpen}
                data-selected-project-id={props.selectedProject?.id ?? ""}
                disabled={props.projects.length === 0}
                onClick={() => setProjectMenuOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  setProjectMenuOpen(true);
                }}
              >
                <span className="project-avatar" aria-hidden="true">{props.selectedProject?.name.slice(0, 1).toUpperCase() ?? "–"}</span>
                <span className="project-trigger-copy">
                  <strong id="project-title">{props.selectedProject?.name ?? "No Project"}</strong>
                  {props.selectedProject?.connectionProfileName && props.projects.some((project) => project.connectionProfileId !== "local")
                    ? <small>{props.selectedProject.connectionProfileName}{selectedSourceOffline ? " · Offline" : ""}</small>
                    : null}
                </span>
                <Icon name="chevronDown" />
              </button>
              {selectedSourceOffline && props.selectedProject ? (
                <ProjectSourceRefreshButton
                  sourceName={props.selectedProject.connectionProfileName ?? props.selectedProject.name}
                  refresh={() => props.reconnectSource(selectedConnectionProfileId)}
                />
              ) : null}
            </div>
          </ProjectCheckoutHeader>
          <WorkspaceViewSwitch
            view={workspaceView}
            viewActive={railMode === "workspace"}
            disabled={disabled}
            agents={props.agentCapabilities}
            select={selectWorkspaceView}
            launchTerminal={props.launchTerminal}
            launchAgent={launchOrConfigureAgent}
            setupDevServer={props.selectedProject && !devServerRun ? () => setRunEditor("new") : undefined}
            runDevServer={props.selectedProject && devServerRun ? {
              name: devServerRun.name,
              running: projectRunLive,
              edit: () => setRunEditor(devServerRun),
              start: () => {
                if (projectRunLive && projectRunSessionId) {
                  props.selectSession(projectRunSessionId);
                  return;
                }
                void props.launchProjectRun(props.selectedProject!.id, devServerRun.id, false);
              },
            } : undefined}
            attentionCount={activeAgentAttentionCount}
            taskAttentionCount={taskAttentionCount}
            viewAction={railMode !== "workspace"
              ? undefined
              : workspaceView === "overview"
                ? { label: "Create Task", icon: "add", disabled, run: () => setTaskCreateRequested(true) }
                : workspaceView === "agents"
                  ? { label: agentSearchOpen ? "Close agent search" : "Search active agents", icon: "search", pressed: agentSearchOpen, run: () => setAgentSearchOpen((open) => !open) }
                  : undefined}
            secondaryAction={railMode === "workspace" && workspaceView === "overview" && props.selectedProject
              ? { label: "Tasks", icon: "task", pressed: stagePage?.kind === "taskSources", run: () => openStagePage({ kind: "taskSources" }) }
              : undefined}
          />
          <div className="sidebar-scroll">
          {railMode === "skills" ? <SkillsRail
            load={props.loadSkillCatalog}
            setDeployment={props.setSkillDeployment}
            openEditor={(skillId) => openStagePage({ kind: "skill", id: skillId })}
            improveSkill={props.selectedProject
              ? (skillId, name) => openSettingsImproverSetup(
                { kind: "skill", id: skillId, name: null, path: null, content: null },
                `${name} skill`,
              )
              : undefined}
            disabled={disabled}
          /> : railMode === "context" ? <ContextBankRail
            projectOpen={Boolean(props.selectedProject)}
            load={props.loadContextBankCatalog}
            refreshToken={contextBankRefreshToken}
            selectedFileId={stagePage?.kind === "contextFile" ? stagePage.id : undefined}
            openFile={(fileId) => openStagePage({ kind: "contextFile", id: fileId })}
            resolveConflict={props.resolveContextBankSiblingConflict}
          /> : railMode === "mcp" ? <McpRail
            settings={mcpLibrary.value}
            error={mcpLibrary.error}
            loading={mcpLibrary.loading}
            selectedTool={stagePage?.kind === "mcpTool" ? stageMcpTool?.name : undefined}
            openTool={(tool) => openStagePage({ kind: "mcpTool", id: tool })}
            improveTool={props.selectedProject
              ? (tool, title) => openSettingsImproverSetup(
                { kind: "mcpTool", id: tool, name: null, path: null, content: null },
                title,
              )
              : undefined}
            reload={mcpLibrary.reload}
          /> : railMode === "prompts" ? <PromptsRail
            prompts={promptLibrary.value}
            error={promptLibrary.error}
            loading={promptLibrary.loading}
            selectedId={stagePage?.kind === "prompt" ? stagePage.id : undefined}
            openPrompt={openPromptPage}
            improvePrompt={props.selectedProject ? improvePrompt : undefined}
            reload={promptLibrary.reload}
          /> : workspaceView === "overview" ? <TaskRail
            projectId={props.selectedProject?.id}
            projectFolder={props.selectedProject?.folder_path}
            tasks={props.projectTasks}
            gitHostProjections={props.gitHostProjections}
            branchCommitSummaries={props.branchCommitSummaries}
            runConfigurations={props.runConfigurations}
            runRuntimes={props.runRuntimes}
            runStateRevision={props.runStateRevision}
            sessionsById={sessionsById}
            agentGroups={scopedAgentGroups}
            detachedRelationshipSessionIds={props.detachedRelationshipSessionIds}
            detachRelationship={props.detachAgentRelationship}
            renameAgentGroup={props.renameAgentGroup}
            ungroupAgentGroup={props.ungroupAgentGroup}
            statusesById={statusesById}
            reviewReadySessionIds={props.reviewReadySessionIds}
            selectedSessionId={props.selectedSession?.id}
            visibleSessionIds={props.visibleSessionIds}
            menuSessionId={sessionMenu?.sessionId}
            deletingTaskIds={props.deletingTaskIds}
            provisioningTaskIds={backgroundProvisioningTaskIds}
            selectSession={selectSession}
            openSessionMenu={openSessionMenu}
            dismissSession={dismissSession}
            resumeSession={retrySession}
            disabled={disabled}
            createTask={props.createTask}
            updateTask={props.updateTask}
            bindTaskBranch={props.bindTaskBranch}
            listProjectLocalBranches={props.listProjectLocalBranches}
            loadProjectTaskAutomation={props.taskSourceActions.getProjectAutomation}
            provisionTaskWorktree={props.provisionTaskWorktree}
            dismissTaskWorktreeProvisioning={props.dismissTaskWorktreeProvisioning}
            inspectTaskWorktreeCleanup={props.inspectTaskWorktreeCleanup}
            cleanupTaskWorktree={props.cleanupTaskWorktree}
            openTaskChanges={(taskId, source) => setChangesPresentation({ kind: "task", taskId, source })}
            openTaskDetail={openTaskDetail}
            detailTaskId={detailTask?.id}
            agentCapabilities={props.agentCapabilities}
            launchTaskTerminal={props.launchTaskTerminal}
            launchTaskAgent={props.launchTaskAgent}
            runImprovement={props.runImprovement}
            setupRunImprovement={openRunImproverSetup}
            saveRunConfiguration={props.saveRunConfiguration}
            deleteRunConfiguration={props.deleteRunConfiguration}
            launchTaskRun={props.launchTaskRun}
            inspectTaskWorktreeRepair={props.inspectTaskWorktreeRepair}
            repairTaskWorktree={props.repairTaskWorktree}
            dismissTaskWorktreeRepair={props.dismissTaskWorktreeRepair}
            setTaskClosed={props.setTaskClosed}
            inspectTaskArchive={props.inspectTaskArchive}
            archiveTask={props.archiveTask}
            archivedTaskCount={archived.count}
            archivedTasksChanged={archived.reload}
            deleteTaskAndWorktree={props.deleteTaskAndWorktree}
            openExternal={props.openExternal}
            provisionRequestedTaskId={provisionRequestedTaskId}
            provisionRequestHandled={() => setProvisionRequestedTaskId(undefined)}
            createRequested={taskCreateRequested}
            createRequestHandled={() => setTaskCreateRequested(false)}
            overlayVisibilityChanged={setTaskRailOverlayOpen}
            overlayContainer={props.overlayContainer}
          /> : workspaceView === "agents" ? <>
          <ActiveAgentRail
            sessions={props.projectSessions}
            searchOpen={agentSearchOpen}
            setSearchOpen={setAgentSearchOpen}
            agentGroups={scopedAgentGroups}
            detachedRelationshipSessionIds={props.detachedRelationshipSessionIds}
            detachRelationship={props.detachAgentRelationship}
            renameAgentGroup={props.renameAgentGroup}
            ungroupAgentGroup={props.ungroupAgentGroup}
            projectFolder={props.selectedProject?.folder_path}
            selectedSession={props.selectedSession}
            visibleSessionIds={props.visibleSessionIds}
            statusesById={statusesById}
            rememberedActivityBySessionId={rememberedAgentActivityBySessionId}
            reviewReadySessionIds={props.reviewReadySessionIds}
            favoriteSessionIds={favoriteAgentSessionIds}
            taskAttachedSessionIds={attachedSessionIds}
            worktreeChangesBySessionId={worktreeChangesBySessionId}
            menuSessionId={sessionMenu?.sessionId}
            selectSession={selectSession}
            navigateSession={navigateSession}
            openSessionMenu={openSessionMenu}
            dismissSession={dismissSession}
            resumeSession={retrySession}
            archiveSession={(sessionId) => { void props.archiveSession(sessionId).then((failure) => { if (!failure) archived.reload(); }); }}
            toggleFavoriteSession={toggleFavoriteAgentSession}
            openTaskChanges={(taskId) => setChangesPresentation({ kind: "task", taskId, source: { kind: "local" } })}
            openQuickAction={disabled ? undefined : () => openQuickAction()}
          />
          <SessionRail
            sessions={looseSessions}
            selectedSession={props.selectedSession}
            visibleSessionIds={props.visibleSessionIds}
            menuSessionId={sessionMenu?.sessionId}
            selectSession={selectSession}
            navigateSession={navigateSession}
            openSessionMenu={openSessionMenu}
            dismissSession={dismissSession}
            resumeSession={retrySession}
            reorderSession={props.reorderSession}
            runRuntimes={props.runRuntimes}
            runConfigurations={props.runConfigurations}
            restartRun={props.selectedProject
              ? (configurationId) => props.launchProjectRun(props.selectedProject!.id, configurationId, true)
              : undefined}
            openExternal={props.openExternal}
          />
          </> : workspaceView === "history" ? <HistoryRail
            projectId={props.selectedProject?.id}
            projectPath={props.selectedProject?.folder_path}
            projectBranch={props.projectWorktreeSummary?.checked_out_branch}
            currentCwd={props.selectedSession?.process.cwd ?? props.selectedProject?.folder_path}
            sessions={props.projectSessions}
            archivedSessions={archived.sessions}
            deletedSessions={deleted.sessions}
            favoriteSessionIds={favoriteAgentSessionIds}
            termLoopHistoryLoading={archived.loading || deleted.loading}
            selectedSessionId={props.selectedSession?.id}
            disabled={disabled}
            load={props.loadSessionHistory}
            loadTermLoopPreview={props.loadSessionHistoryPreview}
            resumeExternal={props.resumeHistorySession}
            selectSession={selectSession}
            resumeSession={retrySession}
            restoreArchivedSession={archived.restoreSession}
            deleteArchivedSession={(sessionId) => {
              void props.deleteArchivedSession(sessionId).then((failure) => {
                if (failure) return;
                archived.reload();
                deleted.reload();
              });
            }}
            restoreDeletedSession={deleted.restore}
          /> : assistantProjectId ? <AssistantRail
            projectId={assistantProjectId}
            refreshToken={props.assistantRefreshToken}
            sessions={props.projectSessions}
            statusesById={statusesById}
            tasks={props.projectTasks}
            playbookRuntime={props.playbookRuntime}
            disabled={disabled}
            selectedSessionId={props.selectedSession?.id}
            selection={assistantSelection}
            agentCapabilities={props.agentCapabilities}
            getSteward={props.assistantActions.getConfiguration}
            setSteward={props.assistantActions.setConfiguration}
            deleteSteward={props.assistantActions.deleteConfiguration}
            listWorkers={props.assistantActions.listWorkers}
            createWorker={props.assistantActions.createWorker}
            updateWorker={props.assistantActions.updateWorker}
            deleteWorker={props.assistantActions.deleteWorker}
            listRoutines={props.assistantActions.listRoutines}
            listRuntime={props.assistantActions.listRoutineRuntime}
            getPlaybook={props.assistantActions.getPlaybook}
            updatePlaybook={props.assistantActions.updatePlaybook}
            setPlaybookTaskPosition={props.assistantActions.setPlaybookTaskPosition}
            runRoutineNow={props.assistantActions.runRoutineNow}
            createRoutine={props.assistantActions.createRoutine}
            updateRoutine={props.assistantActions.updateRoutine}
            deleteRoutine={props.assistantActions.deleteRoutine}
            improvement={props.assistantActions.promptImprovement}
            setupPromptImprovement={openPromptImproverSetup}
            restartWorker={props.assistantActions.restartWorker}
            restartSteward={props.assistantActions.restartSteward}
            selectSession={selectAssistantSession}
            openImproverTerminal={openImproverTerminal}
            dismissImproverSession={dismissSession}
            openTask={openTaskDetail}
            openDetails={openAssistant}
          /> : <p className="assistant-empty">Select a Project to configure assistants.</p>}
          </div>
          {/* Archived Agent history lives in History; this footer is Task-only. */}
          {archivedRailVisible(railMode === "workspace", workspaceView) ? <ArchivedRail
            tasks={archived.tasks}
            loading={archived.loading}
            disabled={disabled}
            deletingTaskIds={props.deletingTaskIds}
            restore={archived.restore}
            inspectTaskWorktreeCleanup={props.inspectTaskWorktreeCleanup}
            deleteTask={(task, review) => props.deleteArchivedTaskAndWorktree(task, review).then((result) => {
              if (result.status === "completed") archived.reload();
              return result;
            })}
            overlayVisibilityChanged={setArchivedRailOverlayOpen}
            overlayContainer={props.overlayContainer}
          /> : null}
          <footer className="sidebar-footer">
            {assistantProjectId ? <StewardPetHost
              projectId={assistantProjectId}
              refreshToken={props.assistantRefreshToken}
              sessions={props.projectSessions}
              agentStatuses={props.agentStatuses}
              compact
              setEnabled={async (enabled) => {
                const current = await props.assistantActions.getConfiguration();
                const configuration = current.configuration;
                if (!configuration) return;
                await props.assistantActions.setConfiguration(
                  configuration.agentId,
                  configuration.model,
                  configuration.permission,
                  configuration.reasoning,
                  enabled,
                  configuration.systemPrompt,
                  current.stateRevision,
                );
              }}
              userBusy={false}
              getSteward={props.assistantActions.getConfiguration}
              getPlaybook={props.assistantActions.getPlaybook}
              openPlaybookSetup={openPlaybookBuilder}
              listTranscript={props.assistantActions.listTranscript}
              respondToProposal={props.assistantActions.respondToProposal}
              acceptSuggestion={props.assistantActions.acceptSuggestion}
              listRuntime={props.assistantActions.listRoutineRuntime}
              openSteward={() => openAssistant({ kind: "steward", initialView: "terminal" })}
              dismissUtterance={() => undefined}
              openReference={() => openAssistant({ kind: "steward", initialView: "terminal" })}
            /> : null}
            <div className="sidebar-footer-actions">
              <button className="server-connect-trigger" type="button" onClick={() => setConnectionProfilesOpen(true)}>Servers</button><button className="mobile-connect-trigger" type="button" onClick={() => setMobileConnectOpen(true)}>Connect Mobile</button><KeepAwakePanel load={props.loadKeepAwake} save={props.setKeepAwake} refreshToken={props.keepAwakeRefreshToken} />{!props.isPackaged ? <ErrorLogPanel entries={props.errorLog} clear={props.clearErrorLog} /> : null}
            </div>
          </footer>
        </aside>
        <SidebarResizeHandle
          width={sidebarWidth}
          resize={resizeSidebar}
          reset={() => {
            clearSidebarWidth();
            setSidebarWidth(sidebarMaximumWidth(window.innerWidth));
          }}
          draggingChanged={setSidebarDragging}
        />
        <section className="workspace" aria-label="Terminal workspace">
          {!assistantStageVisible && !detailTask && !stagePage && props.selectedProject ? <SessionTabStrip
            sessions={props.projectSessions.filter((session) => !isAssistantSession(session))}
            selectedSessionId={props.selectedSession?.id}
            disabled={disabled}
            selectSession={selectSession}
            launchTerminal={props.launchTerminal}
          /> : null}
          <main className="terminal-stage" aria-label="Terminal panes">
            {assistantStageVisible && assistantSelection && props.selectedProject ? <StewardPanel
              projectId={props.selectedProject.id}
              projectName={props.selectedProject.name}
              selection={assistantSelection}
              refreshToken={props.assistantRefreshToken}
              agentCapabilities={props.agentCapabilities}
              playbookBuilderSessionId={playbookBuilderSession(props.selectedProject.id, props.projectSessions)?.id}
              close={() => setAssistantSelection(undefined)}
              openTerminal={selectAssistantSession}
              openTermLoopInstructions={() => openPromptPage("runtime.steward.protected")}
              setupPromptImprovement={openPromptImproverSetup}
              renderTerminal={(sessionId) => <AssistantTerminalHost
                sessionId={sessionId}
                session={sessionsById.get(sessionId)}
                bindTerminalHost={props.bindTerminalHost}
                resumeSession={props.resumeSession}
                repairProviderHistory={setProviderHistoryRepairSessionId}
              />}
              {...props.assistantActions}
            /> : detailTask ? <TaskDetailPanel
              key={detailTask.id}
              task={detailTask}
              refreshToken={props.assistantRefreshToken}
              sessions={detailSessions}
              statusesById={statusesById}
              reviewReadySessionIds={props.reviewReadySessionIds}
              gitHostProjection={props.gitHostProjections.find((projection) => projection.task_id === detailTask.id)}
              branchCommitSummary={props.branchCommitSummaries.find((summary) => summary.task_id === detailTask.id)}
              close={() => setDetailTaskId(undefined)}
              selectSession={selectSession}
              openChanges={(source) => setChangesPresentation({ kind: "task", taskId: detailTask.id, source })}
              openExternal={props.openExternal}
              openPlaybook={revealStewardRail}
              getPlaybook={props.assistantActions.getPlaybook}
              getPlaybookRuntime={props.assistantActions.getPlaybookRuntime}
              setPlaybookTaskPosition={props.assistantActions.setPlaybookTaskPosition}
              listRoutines={props.assistantActions.listRoutines}
              listRoutineRuntime={props.assistantActions.listRoutineRuntime}
              runRoutineNow={props.assistantActions.runRoutineNow}
            /> : stagePage?.kind === "skill" ? <SkillEditorPanel
              key={stagePage.id}
              skillId={stagePage.id}
              load={props.loadSkillDefinition}
              save={props.saveSkillDefinition}
              versions={props.settingsImprovement}
              close={() => setStagePage(undefined)}
            /> : stagePage?.kind === "contextFile" ? <ContextBankEditorPanel
              key={stagePage.id}
              fileId={stagePage.id}
              load={props.loadContextBankFile}
              save={props.saveContextBankFile}
              onSaved={() => setContextBankRefreshToken((current) => current + 1)}
              close={() => setStagePage(undefined)}
            /> : stagePage?.kind === "mcpTool" ? (stageMcpTool && mcpLibrary.value ? <McpToolPanel
              key={stageMcpTool.name}
              tool={stageMcpTool}
              stateRevision={mcpLibrary.value.stateRevision}
              update={props.updateMcpToolDescription}
              reset={props.resetMcpToolDescription}
              apply={mcpLibrary.set}
              versions={props.settingsImprovement}
              reload={mcpLibrary.reload}
              close={() => setStagePage(undefined)}
            /> : <StageEditorPlaceholder
              label="MCP tool"
              error={mcpLibrary.error}
              loaded={Boolean(mcpLibrary.value)}
              close={() => setStagePage(undefined)}
            />) : stagePage?.kind === "taskSources" && props.selectedProject ? <TaskSourcesPanel
              key={props.selectedProject.id}
              projectId={props.selectedProject.id}
              projectName={props.selectedProject.name}
              refreshToken={props.taskSourceRefreshToken}
              actions={props.taskSourceActions}
              agentCapabilities={props.agentCapabilities}
              openTask={(taskId) => { setWorkspaceView("overview"); openTaskDetail(taskId); }}
              openExternal={props.openExternal}
              close={() => setStagePage(undefined)}
            /> : stagePage?.kind === "prompt" ? (stagePrompt ? <PromptPanel
              key={stagePrompt.id}
              prompt={stagePrompt}
              update={props.updatePromptAsset}
              reset={props.resetPromptAsset}
              apply={promptLibrary.set}
              versions={props.settingsImprovement}
              reload={promptLibrary.reload}
              close={() => setStagePage(undefined)}
            /> : <StageEditorPlaceholder
              label="Prompt"
              error={promptLibrary.error}
              loaded={Boolean(promptLibrary.value)}
              close={() => setStagePage(undefined)}
            />) : <>
            {props.layout ? (
              <PaneTree
                node={props.layout.root}
                activePaneId={props.layout.activePaneId}
                sessions={sessionsById}
                bindTerminalHost={props.bindTerminalHost}
                focusPane={props.focusPane}
                resizeSplit={props.resizeLayoutSplit}
                closePane={props.closePane}
                clearPane={props.clearPane}
                terminalResizeOwner={props.terminalResizeOwner}
                launchTerminal={props.launchTerminal}
                resumeSession={props.resumeSession}
                repairProviderHistory={setProviderHistoryRepairSessionId}
                closeSession={props.closeSession}
              />
            ) : <EmptyWorkspace hasProject={Boolean(props.selectedProject)} connected={props.connection === "connected"} addProject={props.openProjectDialog} launchTerminal={props.launchTerminal} />}
            </>}
            {/* Sits outside the stage's own branch so a diff opened from the
                Task detail page covers that page and closes back onto it,
                rather than throwing the reader out to the terminal. Opening the
                Steward already dismisses it, so it never stacks on that panel. */}
            {changesSubject ? (
              <ChangesOverlay
                key={`${changesSubject.kind}:${changesSubject.id}`}
                subject={changesSubject}
                initialSource={changesPresentation?.kind === "task" ? changesPresentation.source : { kind: "local" }}
                close={() => setChangesPresentation(undefined)}
                list={changesSubject.kind === "project" ? props.listProjectWorktreeChanges : props.listTaskWorktreeChanges}
                diff={changesSubject.kind === "project" ? props.getProjectWorktreeDiff : props.getTaskWorktreeDiff}
                preImage={changesSubject.kind === "project" ? props.getProjectWorktreePreImage : props.getTaskWorktreePreImage}
                listCommits={props.listTaskBranchCommits}
                listCommitChanges={props.listTaskBranchCommitChanges}
                commitDiff={props.getTaskBranchCommitDiff}
                gitHostProjection={changesGitHostProjection}
                listPullRequestChanges={props.listTaskPullRequestChanges}
                pullRequestDiff={props.getTaskPullRequestDiff}
                agentSessions={changesAgentSessions}
                sendReviewNotes={changesSubject.kind === "project" ? props.sendProjectReviewNotes : props.sendTaskReviewNotes}
              />
            ) : null}
          </main>
        </section>
      </div>
      </SidebarSessionDndProvider>
      <OverlayPortal container={props.overlayContainer}>
      {projectMenuOpen ? (
        <>
          <button className="project-menu-backdrop" type="button" tabIndex={-1} aria-hidden="true" onClick={() => closeProjectMenu()} />
          <div ref={projectMenuRef} className="project-menu" style={projectMenuStyle} role="menu" aria-label="Project menu" onKeyDown={handleProjectMenuKeyDown}>
            <div className="project-menu-list">
              {projectSourceGroups.map((group) => (
                <div className="project-source-group" key={group.profileId}>
                  {showProjectSourceGroups ? <div className="project-source-heading">{group.name}</div> : null}
                  {group.projects.map((project) => {
                    const selected = project.id === props.selectedProject?.id;
                    return (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitem"
                    aria-current={selected ? "true" : undefined}
                    data-connection-state={project.connectionState ?? "connected"}
                    data-project-option-id={project.id}
                    data-project-selected={selected ? "true" : undefined}
                    onClick={() => { selectProject(project.id); closeProjectMenu(true); }}
                  >
                    <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
                    <span className="project-menu-project-copy">
                      <strong>{project.name}</strong>
                      {props.projects.some((candidate) => candidate.connectionProfileId !== "local")
                        ? <small>{project.connectionProfileName ?? "This computer"}{project.connectionState === "offline" ? " · Offline" : ""}</small>
                        : null}
                    </span>
                    <span className="project-selected-mark" aria-hidden="true">{selected ? "✓" : ""}</span>
                  </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="project-menu-divider" role="separator" />
            <button type="button" role="menuitem" disabled={projectActionDisabled} onClick={() => { closeProjectMenu(); openStagePage({ kind: "taskSources" }); }}><Icon name="task" /><span className="project-menu-label">Tasks</span></button>
            <button type="button" role="menuitem" disabled={projectActionDisabled} onClick={() => { closeProjectMenu(); setEditProjectOpen(true); }}><Icon name="edit" /><span className="project-menu-label">Edit Project</span></button>
            <button type="button" role="menuitem" className="danger" disabled={projectActionDisabled} onClick={() => { closeProjectMenu(); setDeleteProjectOpen(true); }}><Icon name="trash" /><span className="project-menu-label">Delete Project</span></button>
          </div>
        </>
      ) : null}
      <ProjectDialog
        open={props.projectDialogOpen}
        close={props.closeProjectDialog}
        projects={props.projects}
        listProfiles={props.listConnectionProfiles}
        defaultProjectsRoot={props.defaultProjectsRoot}
        browseDirectory={props.browseDirectory}
        createProject={props.createProject}
        pickLocalFolder={props.pickLocalFolder}
      />
      {editProjectOpen && props.selectedProject ? <ProjectDetailsDialog
        key={props.selectedProject.id}
        project={props.selectedProject}
        projects={props.projects}
        close={() => setEditProjectOpen(false)}
        defaultProjectsRoot={() => props.defaultProjectsRoot(props.selectedProject?.connectionProfileId ?? "local")}
        actions={{
          defaultRoot: () => props.defaultProjectsRoot(props.selectedProject?.connectionProfileId ?? "local"),
          browse: (folderPath) => props.browseDirectory(props.selectedProject?.connectionProfileId ?? "local", folderPath),
        }}
        updateProject={props.updateProject}
        pickLocalFolder={props.pickLocalFolder}
      /> : null}
      {deleteProjectOpen && props.selectedProject ? <DeleteProjectDialog project={props.selectedProject} close={() => setDeleteProjectOpen(false)} deleteProject={props.deleteProject} /> : null}
      {renameTarget ? <RenameSessionDialog session={renameTarget} close={() => setRenameSessionId(undefined)} rename={(name) => props.renameSession(renameTarget.id, name)} /> : null}
      {providerHistoryRepairSession ? <ProviderHistoryRepairDialog
        session={providerHistoryRepairSession}
        repair={props.repairProviderHistory}
        close={() => setProviderHistoryRepairSessionId(undefined)}
      /> : null}
      {commandPaletteOpen ? <CommandPalette commands={commands} platform={platform} close={closeCommandPalette} /> : null}
      {quickActionOpen ? <QuickActionComposer
        projects={props.projects.filter((project) => (
          project.connectionProfileId === props.selectedProject?.connectionProfileId
        ))}
        selectedProject={props.selectedProject}
        capabilities={props.agentCapabilities}
        {...(quickActionAgent ? { initialAgent: quickActionAgent } : {})}
        pasteImage={props.pasteQuickActionImage}
        restoreImage={props.restoreQuickActionImage}
        discardImage={props.discardQuickActionImage}
        preview={props.previewQuickAction}
        launch={props.launchQuickAction}
        close={() => { setQuickActionOpen(false); setQuickActionAgent(undefined); }}
      /> : null}
      {improverSetup && props.selectedProject ? <AgentSetupDialog
        project={props.selectedProject}
        title={improverSetupTitle(improverSetup)}
        capabilities={props.agentCapabilities}
        start={async (selection, options) => {
          const failure = improverSetup.kind === "prompt"
            ? await (props.assistantActions.promptImprovement?.start(improverSetup.target, selection, options)
              ?? Promise.resolve("Prompt improvement is unavailable."))
            : improverSetup.kind === "settings"
              ? await props.settingsImprovement.start(improverSetup.target, selection, options)
              : await props.runImprovement.start(improverSetup.projectId, improverSetup.target, selection, options);
          if (!failure && improverSetup.kind === "prompt" && improverSetup.target.surface === "playbook") {
            openPlaybookBuilder();
          }
          return failure;
        }}
        close={() => setImproverSetup(undefined)}
      /> : null}
      {shortcutSettingsOpen ? <KeyboardShortcutsDialog platform={platform} close={() => setShortcutSettingsOpen(false)} /> : null}
      {runEditor && props.selectedProject ? <RunEditorDialog
        projectId={props.selectedProject.id}
        {...(runEditor === "new" ? { seed: DEV_SERVER_SEED } : { configuration: runEditor })}
        improvement={props.runImprovement}
        setupImprovement={openRunImproverSetup}
        stateRevision={props.runStateRevision}
        canRun={false}
        close={() => setRunEditor(undefined)}
        save={props.saveRunConfiguration}
        remove={props.deleteRunConfiguration}
        run={async () => undefined}
      /> : null}
      {mobileConnectOpen ? <MobileConnectDialog prepare={props.prepareMobileAccess} close={() => setMobileConnectOpen(false)} /> : null}
      {connectionProfilesOpen ? <ConnectionProfilesDialog
        list={props.listConnectionProfiles}
        connect={props.connectConnectionProfile}
        setEnabled={props.setConnectionProfileEnabled}
        remove={props.removeConnectionProfile}
        subscribeStatus={props.subscribeConnectionStatus}
        discoverTailscaleServers={props.discoverTailscaleServers}
        hostStatus={props.remoteHostStatus}
        enableHost={props.enableRemoteHost}
        disableHost={props.disableRemoteHost}
        close={() => setConnectionProfilesOpen(false)}
      /> : null}
      {sessionMenu && menuSession ? (
        <SessionContextMenu
          state={sessionMenu}
          session={menuSession}
          visible={props.visibleSessionIds.has(menuSession.id)}
          canSplit={layoutPanes.length < MAX_LAYOUT_PANES}
          closeMenu={() => {
            const invoker = sessionMenu.invoker;
            setSessionMenu(undefined);
            requestAnimationFrame(() => invoker.focus());
          }}
          openHere={() => selectSession(menuSession.id)}
          openInSplit={(direction) => props.openSessionInSplit(menuSession.id, direction)}
          focus={() => selectSession(menuSession.id)}
          closePane={() => closeSessionPane(menuSession.id)}
          rename={() => setRenameSessionId(menuSession.id)}
          forkSession={() => {
            void props.forkSession(menuSession.id).then((requiresRepair) => {
              if (requiresRepair) setProviderHistoryRepairSessionId(menuSession.id);
            });
          }}
          repairProviderHistory={menuSession.resume_failure_reason === "providerHistoryDamaged"
            ? () => setProviderHistoryRepairSessionId(menuSession.id)
            : undefined}
          refreshAgent={menuAgentActions ? () => void props.restartAgent(menuSession.id) : undefined}
          agentActions={menuAgentActions}
          runDevServer={menuRunDevServer}
          relocateSession={isTaskRelocationDragCandidate(menuSession)
            && !attachedSessionIds.has(menuSession.id)
            && !isAssistantSession(menuSession)
            ? () => {
              setRelocationTaskId(undefined);
              setRelocationMode(undefined);
              setRelocationSessionId(menuSession.id);
            }
            : undefined}
          relocateToProject={isProjectRelocationDragCandidate(menuSession)
            && attachedSessionIds.has(menuSession.id)
            && !isAssistantSession(menuSession)
            ? () => setProjectRelocationSessionId(menuSession.id)
            : undefined}
          copySessionId={() => void props.copySessionId(menuSession.id)}
          dismissSession={() => void props.dismissSession(menuSession.id)}
        />
      ) : null}
      {relocationSession ? <SessionRelocationDialog
        session={relocationSession}
        tasks={props.projectTasks}
        initialTaskId={relocationTaskId}
        initialMode={relocationMode}
        close={() => {
          setRelocationSessionId(undefined);
          setRelocationTaskId(undefined);
          setRelocationMode(undefined);
        }}
        preview={props.previewSessionRelocation}
        relocate={props.relocateSession}
        repairProviderHistory={() => setProviderHistoryRepairSessionId(relocationSession.id)}
        taskCreation={props.selectedProject?.folder_path.trim() ? {
          projectId: props.selectedProject.id,
          repositoryPath: props.selectedProject.folder_path,
          createTask: props.createTask,
          listBranches: props.listProjectLocalBranches,
          beginProvisioning: (params, mode) => beginBackgroundRelocation(relocationSession.id, params, mode),
        } : undefined}
        provision={(taskId) => {
          setProvisionRequestedTaskId(taskId);
        }}
      /> : null}
      {projectRelocationSession && props.selectedProject ? <SessionProjectRelocationDialog
        session={projectRelocationSession}
        project={props.selectedProject}
        close={() => setProjectRelocationSessionId(undefined)}
        preview={props.previewSessionProjectRelocation}
        relocate={props.relocateSessionToProject}
        repairProviderHistory={() => setProviderHistoryRepairSessionId(projectRelocationSession.id)}
      /> : null}
      <BackgroundSessionRelocation
        intents={backgroundRelocationIntents}
        tasks={props.projectTasks}
        preview={props.previewSessionRelocation}
        relocate={props.relocateSession}
        finish={finishBackgroundRelocation}
        reopen={reopenBackgroundRelocation}
        repairProviderHistory={repairBackgroundRelocation}
      />
      </OverlayPortal>
    </>
  );
}

function SidebarResizeHandle({ width, resize, reset, draggingChanged }: {
  width: number;
  resize(width: number): void;
  reset(): void;
  draggingChanged(dragging: boolean): void;
}) {
  const [dragging, setDragging] = useState(false);
  const displayedWidth = width;
  const maximum = sidebarMaximumWidth(window.innerWidth);
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    draggingChanged(false);
  };
  return (
    <div
      className={`sidebar-resize-handle${dragging ? " dragging" : ""}`}
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(displayedWidth)}
      tabIndex={0}
      title="Drag to resize sidebar · Double-click to reset"
      onDoubleClick={reset}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        draggingChanged(true);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX);
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        const next = event.key === "ArrowLeft" ? displayedWidth - step
          : event.key === "ArrowRight" ? displayedWidth + step
            : event.key === "Home" ? SIDEBAR_MIN_WIDTH
              : event.key === "End" ? maximum
                : undefined;
        if (next === undefined) return;
        event.preventDefault();
        resize(next);
      }}
    />
  );
}

function EmptyWorkspace({ hasProject, connected, addProject, launchTerminal }: { hasProject: boolean; connected: boolean; addProject(): void; launchTerminal(): Promise<void> }) {
  return <div className="empty-state"><div className="empty-art" aria-hidden="true"><Icon name="terminal" /></div><span className="empty-eyebrow">Terminal workspace</span><h1>{hasProject ? "Open a Session." : "Add your first Project."}</h1><p>{hasProject ? "Start a terminal or an agent. Everything running stays available in the rail." : "Projects keep terminals and agents anchored to one local folder."}</p><button className="primary-button" disabled={!connected} onClick={() => hasProject ? void launchTerminal() : addProject()}>{hasProject ? "Open terminal" : "Add Project"}</button></div>;
}

type PaneTreeProps = {
  node: LayoutNode;
  activePaneId: string;
  sessions: ReadonlyMap<string, Session>;
  bindTerminalHost(sessionId: string, host: HTMLElement | null): void;
  focusPane(paneId: string): void;
  resizeSplit(splitId: string, ratio: number): void;
  closePane(paneId: string): void;
  clearPane(paneId: string): void;
  terminalResizeOwner(sessionId: string): boolean | undefined;
  launchTerminal(): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  repairProviderHistory(sessionId: string): void;
  closeSession(sessionId: string): Promise<void>;
};

function PaneTree(props: PaneTreeProps) {
  if (props.node.type === "pane") {
    return <TerminalPane {...props} paneId={props.node.id} sessionId={props.node.sessionId} session={props.node.sessionId ? props.sessions.get(props.node.sessionId) : undefined} active={props.node.id === props.activePaneId} />;
  }
  return (
    <div className={`split-node ${props.node.direction}`} data-split-id={props.node.id} data-ratio={props.node.ratio.toFixed(3)}>
      <div className="split-child" style={{ flexBasis: `${props.node.ratio * 100}%` }}><PaneTree {...props} node={props.node.first} /></div>
      <SplitDivider split={props.node} resize={props.resizeSplit} />
      <div className="split-child" style={{ flexBasis: `${(1 - props.node.ratio) * 100}%` }}><PaneTree {...props} node={props.node.second} /></div>
    </div>
  );
}

export function AssistantTerminalHost({ sessionId, session, bindTerminalHost, resumeSession, repairProviderHistory }: {
  sessionId: string;
  session: Session | undefined;
  bindTerminalHost(sessionId: string, host: HTMLElement | null): void;
  resumeSession(sessionId: string): Promise<void>;
  repairProviderHistory(sessionId: string): void;
}) {
  const hostRef = useCallback((host: HTMLElement | null) => { if (session?.kind === "Agent") bindTerminalHost(sessionId, host); }, [bindTerminalHost, sessionId, session?.runtime_epoch, session?.lifecycle_state, session?.kind]);
  return <div className="assistant-terminal-host" ref={hostRef}>
    {session && sessionShowsRecoveryStrip(session) ? <TerminalRecoveryStrip
      session={session}
      resumeSession={resumeSession}
      repairProviderHistory={repairProviderHistory}
    /> : null}
  </div>;
}

function TerminalRecoveryStrip({ session, resumeSession, repairProviderHistory, closeDescriptor }: {
  session: Session;
  resumeSession(sessionId: string): Promise<void>;
  repairProviderHistory(sessionId: string): void;
  closeDescriptor?: (() => void) | undefined;
}) {
  const resumeLabel = sessionResumeActionLabel(session);
  const repairAvailable = session.resume_failure_reason === "providerHistoryDamaged";
  return <div className={`terminal-recovery-strip ${session.lifecycle_state}`} data-session-recovery-state={session.lifecycle_state}>
    <div><strong>{sessionRecoveryTitle(session)}</strong><span>{sessionRecoveryMessage(session)}</span></div>
    <div className="terminal-recovery-actions">
      {repairAvailable ? <button className="primary-button" type="button" onClick={() => repairProviderHistory(session.id)}>Repair history</button>
        : resumeLabel ? <button className="primary-button" type="button" onClick={() => void resumeSession(session.id)}>{resumeLabel}</button>
        : null}
      {closeDescriptor ? <button className="secondary-button" type="button" onClick={closeDescriptor}>Close Session</button> : null}
    </div>
  </div>;
}

function TerminalPane({ paneId, sessionId, session, active, bindTerminalHost, focusPane, closePane, clearPane, terminalResizeOwner, launchTerminal, resumeSession, repairProviderHistory, closeSession }: PaneTreeProps & { paneId: string; sessionId: string | null; session: Session | undefined; active: boolean }) {
  const splitDrop = useDroppable({
    id: `split-pane:${paneId}`,
    data: { kind: "split", paneId },
  });
  const sidebarDnd = useOptionalSidebarSessionDnd();
  const splitDropTarget = sidebarDnd?.splitDropTarget?.paneId === paneId
    ? sidebarDnd.splitDropTarget
    : undefined;
  const terminalRef = useCallback((host: HTMLElement | null) => { if (session && sessionKeepsTerminalSurface(session)) bindTerminalHost(session.id, host); }, [bindTerminalHost, session?.id, session?.runtime_epoch, session?.lifecycle_state, session?.archived_at_epoch_ms]);
  const launchHere = () => { focusPane(paneId); void launchTerminal(); };
  const closeDescriptor = () => { if (!session) return; void closeSession(session.id).then(() => clearPane(paneId)); };
  const resumeLabel = session ? sessionResumeActionLabel(session) : undefined;
  const repairAvailable = session?.resume_failure_reason === "providerHistoryDamaged";
  const preserveTerminal = session ? sessionKeepsTerminalSurface(session) : false;
  return (
    <section ref={splitDrop.setNodeRef} className={`layout-pane${active ? " active" : ""}${splitDropTarget ? ` split-drop-target ${splitDropTarget.direction} ${splitDropTarget.placement}` : ""}`} data-pane-id={paneId} data-pane-session-id={sessionId ?? ""} data-split-drop-direction={splitDropTarget?.direction} data-split-drop-placement={splitDropTarget?.placement} onPointerDown={() => focusPane(paneId)}>
      <header className="pane-header"><span className="pane-active-dot" aria-hidden="true" /><Icon name={session?.kind === "Agent" ? "agent" : "terminal"} /><strong>{session ? sessionLabel(session) : sessionId ? "Session unavailable" : "Empty pane"}</strong><div className="pane-header-actions">{resumeLabel ? <button type="button" className="pane-retry" title="Retry Agent in this terminal" aria-label={`Retry ${session ? sessionLabel(session) : "Agent"}`} onClick={() => { if (session) void resumeSession(session.id); }}>Retry</button> : null}<button type="button" className="pane-close" title="Close pane — Session keeps running" aria-label="Close pane" onClick={() => closePane(paneId)}><Icon name="close" /></button></div></header>
      {splitDropTarget ? <div className={`pane-split-drop-preview ${splitDropTarget.direction} ${splitDropTarget.placement}`} aria-hidden="true"><span>Drop to split {splitDropLabel(splitDropTarget.direction, splitDropTarget.placement)}</span></div> : null}
      {session && preserveTerminal ? <div className="terminal-pane-body"><div className="terminal-mount" ref={terminalRef} />{terminalResizeOwner(session.id) === false ? <div className="terminal-resize-owner-badge" role="status">Size controlled by another client</div> : null}{sessionShowsRecoveryStrip(session) ? <TerminalRecoveryStrip session={session} resumeSession={resumeSession} repairProviderHistory={repairProviderHistory} {...(sessionDismissCommand(session) ? { closeDescriptor } : {})} /> : null}</div> : session ? (
        <div className={`pane-placeholder ${session.lifecycle_state}`} data-session-recovery-state={session.lifecycle_state}><span className="placeholder-symbol" aria-hidden="true">◇</span><h2>{sessionRecoveryTitle(session)}</h2><p>{sessionRecoveryMessage(session)}</p><div className="placeholder-actions">{repairAvailable ? <button className="primary-button" type="button" onClick={() => repairProviderHistory(session.id)}>Repair history</button> : resumeLabel ? <button className="primary-button" type="button" onClick={() => void resumeSession(session.id)}>{resumeLabel}</button> : null}{sessionDismissCommand(session) ? <button className="secondary-button" type="button" onClick={closeDescriptor}>Close Session</button> : null}</div></div>
      ) : sessionId ? (
        <div className="pane-placeholder missing" data-missing-session-id={sessionId}><span className="placeholder-symbol" aria-hidden="true">◇</span><h2>Session stopped</h2><p>The saved pane stays visible. Nothing was restarted automatically.</p><div className="placeholder-actions"><button className="primary-button" type="button" onClick={launchHere}>Open terminal</button><button className="secondary-button" type="button" onClick={() => clearPane(paneId)}>Remove reference</button></div></div>
      ) : <div className="pane-placeholder empty"><span className="placeholder-symbol" aria-hidden="true"><Icon name="add" /></span><h2>Empty pane</h2><p>Choose a Session in the rail or start a terminal here.</p><button className="primary-button" type="button" onClick={launchHere}>Open terminal</button></div>}
    </section>
  );
}

function sessionRecoveryTitle(session: Session): string {
  if (session.lifecycle_state === "resuming") return "Resuming conversation…";
  if (session.lifecycle_state === "stale") return "Terminal needs reopening";
  if (session.lifecycle_state === "resumeFailed") return "Conversation could not resume";
  return "Session stopped";
}

export function sessionShowsRecoveryStrip(session: Session): boolean {
  if (session.lifecycle_state === "running") return false;
  return session.kind !== "Agent" || session.lifecycle_state === "resumeFailed";
}

export function sessionRecoveryMessage(session: Session): string {
  const messages: Partial<Record<NonNullable<Session["resume_failure_reason"]>, string>> = {
    resumeRefMissing: "TermLoop has no verified provider conversation identity, so it did not open a new conversation.",
    invalidResumeRef: "The saved provider identity is invalid and was not passed to a process.",
    resumeCapabilityUnavailable: "The installed provider does not expose the required safe resume capability.",
    runtimeOwnershipUncertain: "TermLoop could not prove the previous process is gone. Retry checks ownership again.",
    providerSessionUnavailable: "The provider no longer has this conversation locally.",
    providerHistoryDamaged: "The provider conversation history is damaged. TermLoop stopped before writing to it again; repair or recover the provider thread, then retry.",
    resumeRejected: "The provider rejected this resume. Fix its authentication or configuration, then retry.",
    providerMismatch: "The saved provider identity does not match this agent.",
    startupTimedOut: "The provider did not become ready before the bounded timeout.",
    daemonInterrupted: "The daemon stopped while preparing this conversation.",
    resumeQueueFull: "The bounded recovery queue was full. Retry uses the same conversation.",
    ptySpawnFailed: "A new terminal runtime could not be created.",
    cwdUnavailable: "The original working directory or managed worktree proof is unavailable.",
    launchReserved: "A cleanup or repair currently reserves this working directory.",
    runtimeConflict: "Another runtime still owns this Session.",
  };
  return session.resume_failure_reason
    ? messages[session.resume_failure_reason] ?? "TermLoop did not open a new provider conversation."
    : session.lifecycle_state === "stale"
      ? "Generic terminals are never restarted automatically after a daemon restart."
      : session.lifecycle_state === "resuming"
        ? "TermLoop is opening a fresh PTY for the same provider conversation."
        : "This Session is not running.";
}

function splitDropLabel(direction: SplitDirection, placement: SplitPlacement): string {
  if (direction === "horizontal") return placement === "before" ? "left" : "right";
  return placement === "before" ? "up" : "down";
}

function SplitDivider({ split, resize }: { split: SplitNode; resize(splitId: string, ratio: number): void }) {
  const dragging = useRef(false);
  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const container = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!container) return;
    resize(split.id, split.direction === "horizontal" ? (event.clientX - container.left) / container.width : (event.clientY - container.top) / container.height);
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const decrease = split.direction === "horizontal" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
    const increase = split.direction === "horizontal" ? event.key === "ArrowRight" : event.key === "ArrowDown";
    if (!decrease && !increase) return;
    event.preventDefault();
    resize(split.id, split.ratio + (increase ? 0.05 : -0.05));
  };
  return <div className="split-divider" role="separator" tabIndex={0} aria-label={split.direction === "horizontal" ? "Resize left and right panes" : "Resize top and bottom panes"} aria-orientation={split.direction === "horizontal" ? "vertical" : "horizontal"} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(split.ratio * 100)} onKeyDown={keyDown} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={updateFromPointer} onPointerUp={(event) => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragging.current = false; }} />;
}

function DeleteProjectDialog({ project, close, deleteProject }: { project: Project; close(): void; deleteProject(projectId: string): Promise<string | undefined> }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      const failure = await deleteProject(project.id);
      if (failure) setError(failure); else close();
    } finally { setBusy(false); }
  };
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}><button className="dialog-backdrop" aria-label="Cancel deleting Project" onClick={close} /><section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="delete-project-title"><header className="dialog-header"><div><span className="dialog-eyebrow danger-eyebrow">Delete Project</span><h2 id="delete-project-title">Remove {project.name} from TermLoop?</h2></div><button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button></header><div className="dialog-body"><p className="confirm-copy">This force-closes the Project's Sessions and removes everything TermLoop keeps for this Project, including its bounded configuration versions. Your own files in <strong>{project.folder_path}</strong> stay untouched.</p><p className="field-help">Deletion is blocked only while one of its Tasks still has a worktree.</p>{error ? <p className="form-error" role="alert">{error}</p> : null}</div><footer className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={close}>Cancel</button><button id="confirm-delete-project" className="danger-button" disabled={busy} onClick={() => void submit()}>{busy ? "Deleting…" : "Delete Project"}</button></footer></section></div>;
}

function RenameSessionDialog({ session, close, rename }: { session: Session; close(): void; rename(name: string | null): Promise<string | undefined> }) {
  const [name, setName] = useState(session.name ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { requestAnimationFrame(() => inputRef.current?.focus()); }, []);
  const submit = async () => { setBusy(true); setError(undefined); try { const failure = await rename(name.trim() || null); if (failure) setError(failure); else close(); } finally { setBusy(false); } };
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}><button className="dialog-backdrop" aria-label="Cancel renaming Session" onClick={close} /><section className="dialog-card rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-session-title"><header className="dialog-header"><div><span className="dialog-eyebrow">Session</span><h2 id="rename-session-title">Rename {sessionLabel(session)}</h2></div><button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button></header><div className="dialog-body"><label htmlFor="session-name">Name</label><input ref={inputRef} id="session-name" aria-label="Session name" value={name} onChange={(event) => setName([...event.target.value].slice(0, 80).join(""))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }} /><p className="field-help">Leave blank to use the default label.</p>{error ? <p className="form-error" role="alert">{error}</p> : null}</div><footer className="dialog-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Save"}</button></footer></section></div>;
}
