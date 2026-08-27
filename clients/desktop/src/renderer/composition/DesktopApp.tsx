import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { emptyLayoutDocument, panes, type LayoutDocument, type SplitDirection, type SplitPlacement } from "../../layout/model.js";
import { desktopApi, type SourceDesktopApi } from "../transport/desktop-api.js";
import { taskBindBranchFailureMessage } from "../transport/task-branch-binding.js";
import { dismissibleFailedProvisioningOperationId, taskProvisionWorktreeFailureMessage } from "../transport/task-worktree-provisioning.js";
import type { AgentCapabilityDto, AssistantPromptImproverTarget, ConfigurationVersionDto, SettingsImproverTarget, ProjectLocalBranchListResult, ProtocolErrorDetails, RunConfigurationCreateParams, RunConfigurationDto, RunConfigurationImproverTarget, RunConfigurationUpdateParams, TaskBranchCommitSummaryDto, TaskCleanupWorktreeParams, TaskProvisionWorktreeParams, TaskRepairWorktreeParams, VersionedConfigurationTarget } from "@termloop/contract/current";
import { rememberPromptImproverSession } from "../prompt-improver-session-link.js";
import { taskLaunchFailureMessage } from "../transport/task-launch.js";
import { onGatewayState } from "../transport/terminal-port.js";
import { onProjectionInvalidated } from "../transport/projection-events.js";
import { onConnectionStatus } from "../transport/connection-events.js";
import { onAgentAttentionActivated } from "../transport/agent-attention.js";
import {
  layoutPreservationProfileIds,
  projectionStore,
} from "../state/projection-store.js";
import { createProjectionRefreshQueue } from "../state/projection-refresh.js";
import { newlyAwaitingSessions } from "../state/agent-attention-policy.js";
import { newlyReviewReadySessions } from "../state/agent-review-policy.js";
import { presentationStore } from "../state/presentation-store.js";
import { TerminalPool } from "../terminal/terminal-pool.js";
import { XtermSurface } from "../terminal/xterm/xterm-surface.js";
import { xtermRendererMetrics } from "../terminal/xterm/xterm-surface.js";
import { GhosttySurface } from "../terminal/ghostty/ghostty-surface.js";
import { ghosttyBridge } from "../transport/ghostty-bridge.js";
import { terminalRendererKind } from "../terminal/renderer-kind.js";
import { attachTerminal } from "../transport/terminal-port.js";
import type { TaskSourceActions } from "../ui/TaskSourcesPanel.js";
import { Shell } from "../ui/Shell.js";
import { AgentLaunchInspector } from "../ui/AgentLaunchInspector.js";
import { createPromptSettingsActions } from "./prompt-settings-actions.js";
import { taskRowRenders } from "../ui/TaskRail.js";
import { agentForkErrorMessage, agentForkRequiresProviderHistoryRepair, controlErrorMessage, projectDeleteErrorMessage, sessionDismissErrorMessage, sessionRequiresProviderHistoryRepair } from "../control-error.js";
import { automaticGitHostTaskIds, isLiveSession, sessionDismissCommand, sessionLabel, type Session, type Task, type TaskDeleteWorktreeResult, type TaskDeleteWorktreeReview } from "../model.js";
import { orchestrateTaskDelete } from "./task-delete-orchestration.js";
import { dismissSessionDescriptor } from "./session-dismiss.js";
import { retryAgentSession } from "./session-resume.js";
import {
  relocateAgentToProjectWithStartupRetry,
  relocateAgentToTaskWithStartupRetry,
} from "./session-relocation.js";
import {
  assistantImproverSessionTarget,
  resumeImproverOrLaunchFresh,
  runImproverSessionTarget,
  settingsImproverSessionTarget,
  type LegacyImproverIdentity,
} from "./improver-resume.js";
import { automaticBranchCommitTaskIds } from "../model.js";
import { readLastQuickActionAgentSelection, readQuickActionPreset, readTaskAgentPreset, type QuickActionAgentId, type QuickActionAgentSelection } from "../quick-action-memory.js";
import { createLayoutPersistence } from "../state/layout-persistence.js";
import { requireQuickActionSession } from "../quick-action-result.js";
import { GitHostRefreshCoordinator } from "./git-host-refresh.js";
import { BranchCommitRefreshQueue } from "./branch-commit-refresh.js";
import { connectionSnapshotRefresh } from "./connection-refresh.js";
import { executeProviderHistoryRepair, fixProviderHistoryAndRetry } from "./provider-history-repair.js";
import { AssistantRefreshThrottle, timeoutRefreshScheduler } from "./assistant-refresh-throttle.js";
import { presentedAgentStatus } from "../session-presentation.js";
import { nativeTerminalSurfaceVisible, useNativeOverlayWindow } from "./native-overlay-window.js";
import { OverlayPortal } from "../ui/OverlayPortal.js";
import {
  MAX_CHANGE_REVIEW_MESSAGE_BYTES,
  reviewMessageByteLength,
  taskReviewAgentSessions,
  terminalReviewSubmission,
} from "../changes-review.js";
import {
  connectionAttachmentIdentity,
  connectionEntityIdentity,
  connectionProfileIdOf,
} from "../../connection-scope.js";

type OrdinaryAgentLaunchPreset = {
  model: string;
  permission: AgentCapabilityDto["permissions"][number];
  reasoning: AgentCapabilityDto["reasoning"][number];
};

function isQuickActionAgentId(agentId: string): agentId is QuickActionAgentId {
  return agentId.length <= 64 && /^[a-z](?:[a-z0-9]|-[a-z0-9])*$/u.test(agentId);
}

function defaultCapabilityLaunchPreset(capability: AgentCapabilityDto): OrdinaryAgentLaunchPreset {
  return {
    model: capability.models[0] ?? "default",
    permission: capability.permissions[0] ?? "default",
    reasoning: capability.reasoning[0] ?? "default",
  };
}

declare global {
  interface Window {
    termloopDiagnostics?: {
      selectedTerminalProbe(): ReturnType<TerminalPool["probe"]>;
      selectedTerminalText(): Promise<string | undefined>;
      measureSelectedEcho(iterations: number): Promise<{ frameIntervalMs: number; samples: number[]; p50: number; p95: number; p99: number }>;
      refreshProjection(): Promise<void>;
      rendererMetrics(): ReturnType<typeof xtermRendererMetrics>;
      layoutDocument(): LayoutDocument;
      projectionRefreshCount(): number;
      taskPatchCount(): number;
      taskRowRenderCount(): number;
      repairTaskWorktree(params: TaskRepairWorktreeParams): Promise<string | undefined>;
      activateAgentAttention(sessionId: string): boolean;
      reconnectTerminalAttachments(): void;
    };
  }
}

const diagnosticsEnabled = new URLSearchParams(window.location.search).get("diagnostics") === "1";
const terminalPool = new TerminalPool(
  (onInput, onResize) => terminalRendererKind() === "ghostty"
    ? new GhosttySurface(onInput, onResize, ghosttyBridge)
    : new XtermSurface(onInput, onResize),
  attachTerminal,
  diagnosticsEnabled,
);
let layoutLoadPromise: Promise<void> | undefined;
let projectionRefreshCount = 0;
let taskPatchCount = 0;
let statusBaselineReady = false;
let previousAgentStatuses = new Map<string, string>();
const dismissingSessions = new Set<string>();
const gitHostRefreshCoordinator = new GitHostRefreshCoordinator(
  (projectId, taskIds) => sourceApiForProject(projectId).gitHostPullRequestList(projectId, taskIds),
  (projectId, requestedTaskIds, projections) => {
    if (presentationStore.getState().selectedProjectId === projectId) {
      projectionStore.applyGitHostPatch(requestedTaskIds, projections);
    }
  },
);

const runImproverKindLabels: Record<string, string> = {
  devServer: "dev server",
  build: "build",
  testRunner: "test runner",
  typecheck: "type check",
  storybook: "Storybook",
  custom: "run",
};

function legacyRunImproverIdentity(
  target: RunConfigurationImproverTarget,
): LegacyImproverIdentity | undefined {
  if (target.configurationId) {
    const configurations = projectionStore.getSnapshot().runConfigurations;
    const configuration = configurations.find((candidate) => candidate.id === target.configurationId);
    if (!configuration) return undefined;
    return {
      templateRef: "builtin.improver.run-configuration",
      sessionName: `improve: ${configuration.name}`,
      targetNameIsUnique: configurations.filter((candidate) => candidate.name === configuration.name).length === 1,
    };
  }
  const label = target.newKind ? runImproverKindLabels[target.newKind] : undefined;
  return label ? {
    templateRef: "builtin.improver.run-configuration-new",
    sessionName: `set up: ${label}`,
    targetNameIsUnique: true,
  } : undefined;
}

async function legacyAssistantImproverIdentity(
  projectId: string,
  target: AssistantPromptImproverTarget,
): Promise<LegacyImproverIdentity | undefined> {
  if (target.surface === "stewardInstructions") return {
    templateRef: "builtin.improver.steward-instructions",
    sessionName: "improve: Steward instructions",
    targetNameIsUnique: true,
  };
  if (target.surface === "playbook") return {
    templateRef: "builtin.builder.playbook",
    sessionName: "build: Project Playbook",
    targetNameIsUnique: true,
  };
  if (target.surface === "routineBuilder") {
    try {
      const configurations = (await sourceApiForProject(projectId).workerConfigurationList({ projectId })).configurations;
      const worker = configurations.find((candidate) => candidate.id === target.ownerId);
      if (!worker) return undefined;
      return {
        templateRef: "builtin.builder.routine",
        sessionName: `build: Routine for ${worker.name}`,
        targetNameIsUnique: configurations.filter((candidate) => candidate.name === worker.name).length === 1,
      };
    } catch {
      return undefined;
    }
  }
  try {
    const configurations = target.surface === "workerInstructions"
      ? (await sourceApiForProject(projectId).workerConfigurationList({ projectId })).configurations
      : (await sourceApiForProject(projectId).routineConfigurationList({ projectId })).configurations;
    const configuration = configurations.find((candidate) => candidate.id === target.ownerId);
    if (!configuration) return undefined;
    return {
      templateRef: target.surface === "workerInstructions"
        ? "builtin.improver.worker-instructions"
        : "builtin.improver.routine-instructions",
      sessionName: target.surface === "workerInstructions"
        ? `improve: ${configuration.name} instructions`
        : `improve: ${configuration.name}`,
      targetNameIsUnique: configurations.filter((candidate) => candidate.name === configuration.name).length === 1,
    };
  } catch {
    return undefined;
  }
}

async function activateImproverSession(projectId: string, session: Session): Promise<void> {
  projectionStore.upsertSession(session);
  terminalPool.reconcile(projectionStore.getSnapshot().sessions);
  await refreshProjection();
  presentationStore.getState().selectProject(projectId);
  presentationStore.getState().selectSession(projectId, session.id);
  focusTerminalSoon(session.id);
}

const persistLayout = createLayoutPersistence(
  (document) => desktopApi.layoutSave(document),
  (error) => {
    projectionStore.setMessage(`Layout could not be saved: ${controlErrorMessage(error)}`);
  },
);
let observedLayoutRevision = 0;
presentationStore.subscribe((state) => {
  gitHostRefreshCoordinator.activateProject(state.selectedProjectId);
  if (!state.layoutLoaded || state.layoutRevision === observedLayoutRevision) return;
  observedLayoutRevision = state.layoutRevision;
  persistLayout(state);
});

function ensureLayoutsLoaded(): Promise<void> {
  layoutLoadPromise ??= desktopApi.layoutLoad()
    .then((document) => presentationStore.getState().hydrateLayouts(document))
    .catch((error) => {
      presentationStore.getState().hydrateLayouts(emptyLayoutDocument());
      projectionStore.setMessage(`Layout could not be restored: ${controlErrorMessage(error)}`);
    });
  return layoutLoadPromise;
}

async function refreshProjectionOnce(): Promise<void> {
  projectionRefreshCount += 1;
  const availableProfiles = await desktopApi.connectionProfileList();
  const profiles = availableProfiles.filter((profile) => profile.enabled);
  projectionStore.retainSources(new Set(profiles.map((profile) => profile.id)));
  await Promise.all(profiles.map(async (profile) => {
    const snapshotRefresh = connectionSnapshotRefresh(profile);
    if (snapshotRefresh.kind === "retain") {
      projectionStore.setSourceConnection(
        profile.id,
        profile.name,
        snapshotRefresh.state,
        snapshotRefresh.message,
      );
      return;
    }
    const api = desktopApi.source(profile.id);
    try {
      const [projects, sessions, agentStatuses] = await Promise.all([
        api.projectList(),
        api.sessionList(),
        api.agentStatusList(),
      ]);
      projectionStore.applySourceSnapshot(profile.id, profile.name, projects, sessions, agentStatuses);
    } catch (error) {
      projectionStore.setSourceConnection(
        profile.id,
        profile.name,
        "offline",
        controlErrorMessage(error),
      );
    }
  }));
  const base = projectionStore.getSnapshot();
  const projects = base.projects;
  const sessions = base.sessions;
  const agentStatuses = base.agentStatuses;
  const requestedProjectId = presentationStore.getState().selectedProjectId;
  const taskProject = projects.find((project) => project.id === requestedProjectId) ?? projects[0];
  const taskProjectId = taskProject?.id;
  gitHostRefreshCoordinator.activateProject(taskProjectId);
  const sourceApi = desktopApi.source(connectionProfileIdOf(taskProject));
  let tasks: Task[] = [];
  let projectWorktreeSummary;
  let runConfigurationResult = { configurations: [] as RunConfigurationDto[], stateRevision: 0 };
  let runRuntimeResult: Awaited<ReturnType<SourceDesktopApi["runRuntimeList"]>> = { runs: [], stateRevision: 0 };
  let playbookResult: Awaited<ReturnType<SourceDesktopApi["playbookGet"]>> = { playbook: null, stateRevision: 0 };
  let playbookRuntime: Awaited<ReturnType<SourceDesktopApi["playbookRuntime"]>> | undefined;
  if (taskProjectId) {
    try {
      [tasks, projectWorktreeSummary, runConfigurationResult, runRuntimeResult, playbookResult, playbookRuntime] = await Promise.all([
        sourceApi.taskList(taskProjectId),
        sourceApi.projectWorktreeSummary(taskProjectId).catch(() => undefined),
        sourceApi.runConfigurationList({ projectId: taskProjectId }),
        sourceApi.runRuntimeList({ projectId: taskProjectId }),
        sourceApi.playbookGet(taskProjectId),
        sourceApi.playbookRuntime(taskProjectId),
      ]);
    } catch (error) {
      projectionStore.setSourceConnection(
        connectionProfileIdOf(taskProject),
        taskProject.connectionProfileName ?? "Computer",
        "offline",
        controlErrorMessage(error),
      );
      projectionStore.clearSelectedProjectSnapshot();
    }
  }
  if (statusBaselineReady) {
    for (const sessionId of newlyAwaitingSessions(previousAgentStatuses, agentStatuses)) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      void desktopApi.source(connectionProfileIdOf(session)).notifyAgentAttention(sessionId);
    }
    presentationStore.getState().updateReviewReadySessions(
      agentStatuses.filter((status) => status.status === "idle").map((status) => status.sessionId),
      newlyReviewReadySessions(previousAgentStatuses, agentStatuses),
    );
  }
  presentationStore.getState().updateInterruptedSessions(agentStatuses);
  previousAgentStatuses = new Map(agentStatuses.map((status) => [status.sessionId, status.status]));
  statusBaselineReady = true;
  const taskIds = new Set(tasks.map((task) => task.id));
  const retainedGitHost = projectionStore
    .getSnapshot()
    .gitHostProjections
    .filter((projection) => taskIds.has(projection.task_id));
  const retainedBranchCommits = projectionStore
    .getSnapshot()
    .branchCommitSummaries
    .filter((summary) => taskIds.has(summary.task_id));
  projectionStore.applySelectedProjectSnapshot(
    tasks,
    [...retainedGitHost],
    [...retainedBranchCommits],
    projectWorktreeSummary,
    runConfigurationResult.configurations,
    runRuntimeResult.runs,
    Math.max(runConfigurationResult.stateRevision, runRuntimeResult.stateRevision),
    playbookRuntime?.processingTaskId ?? null,
    playbookResult.playbook,
    playbookRuntime ?? null,
  );
  const requestedTaskIds = automaticGitHostTaskIds(tasks);
  if (taskProjectId && requestedTaskIds.length > 0) {
    void refreshGitHostProjection(taskProjectId, requestedTaskIds)
      .catch((error) => projectionStore.setMessage(`PR status unavailable: ${controlErrorMessage(error)}`));
  }
  const requestedBranchTaskIds = automaticBranchCommitTaskIds(tasks);
  if (taskProjectId && requestedBranchTaskIds.length > 0) {
    void branchCommitRefreshQueue.request(taskProjectId, requestedBranchTaskIds);
  }
  terminalPool.reconcile(sessions);
  const sessionsByProject = new Map<string, string[]>();
  for (const project of projects) sessionsByProject.set(project.id, []);
  for (const session of sessions) {
    sessionsByProject.get(session.project_id)?.push(session.id);
  }
  presentationStore.getState().ensureSelection(
    projects.map((project) => project.id),
    sessionsByProject,
    layoutPreservationProfileIds(
      availableProfiles,
      (profileId) => projectionStore.sourceState(profileId),
    ),
  );
}

function sourceApiForProject(projectId: string): SourceDesktopApi {
  const project = projectionStore.getSnapshot().projects.find((candidate) => candidate.id === projectId);
  return project ? desktopApi.source(connectionProfileIdOf(project)) : sourceApiForEntityId(projectId);
}

function sourceApiForTask(taskId: string): SourceDesktopApi {
  const task = projectionStore.getSnapshot().tasks.find((candidate) => candidate.id === taskId);
  return task ? desktopApi.source(connectionProfileIdOf(task)) : sourceApiForEntityId(taskId);
}

function sourceApiForSession(sessionId: string): SourceDesktopApi {
  const session = projectionStore.getSnapshot().sessions.find((candidate) => candidate.id === sessionId);
  return session ? desktopApi.source(connectionProfileIdOf(session)) : sourceApiForEntityId(sessionId);
}

function sourceApiForEntityId(entityId: string): SourceDesktopApi {
  const identity = connectionEntityIdentity(entityId) ?? connectionAttachmentIdentity(entityId);
  if (!identity) throw new Error("Connection source is unavailable");
  return desktopApi.source(identity.profileId);
}

/// An explicit fresh improver start retires the previous Session first so one
/// target never carries two improver conversations. A descriptor the daemon no
/// longer knows counts as already retired.
async function retireImproverSession(sessionId: string): Promise<void> {
  const previous = projectionStore.getSnapshot().sessions.find((value) => value.id === sessionId);
  if (!previous) return;
  await dismissSessionDescriptor(sourceApiForSession(sessionId), previous);
}

function sourceApiForAttachmentId(attachmentId: string): SourceDesktopApi {
  const identity = connectionAttachmentIdentity(attachmentId);
  if (identity) return desktopApi.source(identity.profileId);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(attachmentId)) {
    return desktopApi.source("local");
  }
  throw new Error("Attachment source is unavailable");
}

async function waitForAssistantSession(read: () => Promise<string | null>): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sessionId = await read();
    if (sessionId) return sessionId;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function refreshTaskProjection(taskIds: readonly string[]): Promise<void> {
  const projectId = presentationStore.getState().selectedProjectId;
  if (!projectId || taskIds.length === 0) return;
  const tasks = await sourceApiForProject(projectId).taskList(projectId, [...new Set(taskIds)]);
  taskPatchCount += 1;
  projectionStore.applyTaskPatch(taskIds, tasks);
}

async function refreshGitHostProjection(projectId: string, taskIds: readonly string[]): Promise<void> {
  await gitHostRefreshCoordinator.request(projectId, taskIds);
}

async function loadBranchCommitSummaries(projectId: string, taskIds: readonly string[]): Promise<TaskBranchCommitSummaryDto[]> {
  const summaries: TaskBranchCommitSummaryDto[] = [];
  for (let offset = 0; offset < taskIds.length; offset += 40) {
    summaries.push(...await sourceApiForProject(projectId).taskBranchCommitSummaryList(projectId, taskIds.slice(offset, offset + 40)));
  }
  return summaries;
}

const branchCommitRefreshQueue = new BranchCommitRefreshQueue(
  loadBranchCommitSummaries,
  (projectId, taskIds, summaries) => {
    if (presentationStore.getState().selectedProjectId === projectId) {
      projectionStore.applyBranchCommitPatch(taskIds, summaries);
    }
  },
  (error) => projectionStore.setMessage(`Commit count unavailable: ${controlErrorMessage(error)}`),
);

async function refreshBranchCommitProjection(projectId: string, taskIds: readonly string[]): Promise<void> {
  const unique = [...new Set(taskIds)];
  if (unique.length === 0) return;
  await branchCommitRefreshQueue.request(projectId, unique);
}

async function repairTaskWorktree(params: TaskRepairWorktreeParams): Promise<string | undefined> {
  try {
    const outcome = await sourceApiForTask(params.taskId).taskRepairWorktree(params);
    if (outcome.ok) return undefined;
    const message = taskRepairError(outcome);
    projectionStore.setMessage(message);
    return message;
  } catch (error) {
    const message = controlErrorMessage(error);
    projectionStore.setMessage(message);
    return message;
  }
}

function activateAgentAttention(sessionId: string): boolean {
  const session = projectionStore.getSnapshot().sessions.find((value) =>
    value.id === sessionId && value.kind === "Agent" && value.lifecycle_state === "running"
  );
  if (!session) return false;
  presentationStore.getState().selectProject(session.project_id);
  presentationStore.getState().selectSession(session.project_id, session.id);
  focusTerminalSoon(session.id);
  return true;
}

const refreshProjection = createProjectionRefreshQueue(refreshProjectionOnce);

export function DesktopApp() {
  // Fail closed: a renderer that cannot prove it is a development build must
  // not expose diagnostics in a packaged release.
  const [isPackaged, setIsPackaged] = useState(true);
  const [agentCapabilities, setAgentCapabilities] = useState<AgentCapabilityDto[]>([]);
  const [assistantRefreshToken, setAssistantRefreshToken] = useState(0);
  const [keepAwakeRefreshToken, setKeepAwakeRefreshToken] = useState(0);
  const [taskSourceRefreshToken, setTaskSourceRefreshToken] = useState(0);
  const [deletingTaskIds, setDeletingTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [shellTerminalOccluded, setShellTerminalOccluded] = useState(false);
  const [shellNativeOverlayOpen, setShellNativeOverlayOpen] = useState(false);
  const [launchInspection, setLaunchInspection] = useState<{
    title: string;
    preview: () => ReturnType<typeof desktopApi.agentPreview>;
    launch: (launchTicket: string) => Promise<string | undefined>;
  }>();
  const projection = useSyncExternalStore(projectionStore.subscribe, projectionStore.getSnapshot);
  const presentation = useSyncExternalStore(presentationStore.subscribe, presentationStore.getState);
  useSyncExternalStore(
    terminalPool.subscribeResizeOwnership,
    terminalPool.resizeOwnershipRevision,
  );
  const pendingRunAutoOpenSessionIds = useRef(new Set<string>());
  useEffect(() => {
    void desktopApi.isPackaged().then(setIsPackaged).catch(() => setIsPackaged(true));
  }, []);
  useEffect(() => {
    for (const runtime of projection.runRuntimes) {
      if (!pendingRunAutoOpenSessionIds.current.has(runtime.sessionId)) continue;
      const url = runtime.urls[0];
      if (url) {
        pendingRunAutoOpenSessionIds.current.delete(runtime.sessionId);
        void sourceApiForSession(runtime.sessionId).openExternal(url, runtime.sessionId).catch((error) => {
          projectionStore.setMessage(controlErrorMessage(error));
        });
      } else if (runtime.exitCode !== null) {
        pendingRunAutoOpenSessionIds.current.delete(runtime.sessionId);
      }
    }
  }, [projection.runRuntimes]);
  const nativeOverlayActive = shellNativeOverlayOpen || Boolean(launchInspection);
  const nativeOverlayWasActive = useRef(false);
  const nativeOverlayContainer = useNativeOverlayWindow(
    terminalRendererKind() === "ghostty",
    nativeOverlayActive,
    Boolean(presentation.selectedProjectId),
    desktopApi.nativeOverlaySetVisible,
    desktopApi.nativeOverlaySetPassiveVisible,
    desktopApi.nativeOverlaySetPointerInteractive,
    desktopApi.nativeOverlaySetPassiveRegion,
  );
  useEffect(() => {
    terminalPool.setVisible(nativeTerminalSurfaceVisible(shellTerminalOccluded, nativeOverlayActive));
  }, [nativeOverlayActive, shellTerminalOccluded]);
  const selectedProject = projection.projects.find((project) => project.id === presentation.selectedProjectId);
  const selectedSourceApi = desktopApi.source(connectionProfileIdOf(selectedProject));
  const assistantProjectId = selectedProject?.id ?? "";
  const projectSessions = useMemo(
    () => {
      const sessions = projection.sessions.filter((session) => session.project_id === selectedProject?.id);
      const order = selectedProject ? presentation.sessionOrderByProject[selectedProject.id] ?? [] : [];
      const rank = new Map(order.map((sessionId, index) => [sessionId, index]));
      return [...sessions].sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER));
    },
    [projection.sessions, selectedProject?.id, presentation.sessionOrderByProject],
  );
  const selectedSessionId = selectedProject ? presentation.selectedSessionByProject[selectedProject.id] : undefined;
  const selectedSession = projectSessions.find((session) => session.id === selectedSessionId);
  const selectedRuntimeEpoch = selectedSession?.runtime_epoch;
  const presentedAgentStatuses = useMemo(
    () => projection.agentStatuses.map((status) =>
      presentedAgentStatus(status, presentation.acknowledgedInterruptedSessionObservations)
    ),
    [presentation.acknowledgedInterruptedSessionObservations, projection.agentStatuses],
  );
  useEffect(() => {
    const wasActive = nativeOverlayWasActive.current;
    nativeOverlayWasActive.current = nativeOverlayActive;
    if (wasActive && !nativeOverlayActive && selectedSession) focusTerminalSoon(selectedSession.id);
  }, [nativeOverlayActive, selectedSession?.id]);
  useEffect(() => {
    if (projection.connection !== "connected") {
      setAgentCapabilities([]);
      return;
    }
    let active = true;
    void selectedSourceApi.agentCapabilityList().then((value) => { if (active) setAgentCapabilities(value); }).catch(() => {
      if (active) setAgentCapabilities([]);
    });
    return () => { active = false; };
  }, [projection.connection, selectedProject?.connectionProfileId]);
  const projectLayout = selectedProject ? presentation.layoutsByProject[selectedProject.id] : undefined;
  const visibleSessionIds = useMemo(
    () => new Set(projectLayout ? panes(projectLayout).flatMap((pane) => pane.sessionId ? [pane.sessionId] : []) : []),
    [projectLayout],
  );

  useEffect(() => {
    if (!diagnosticsEnabled) return;
    window.termloopDiagnostics = {
      selectedTerminalProbe: () => selectedSession ? terminalPool.probe(selectedSession.id) : undefined,
      selectedTerminalText: () => selectedSession
        ? terminalPool.diagnosticText(selectedSession.id)
        : Promise.resolve(undefined),
      refreshProjection,
      rendererMetrics: xtermRendererMetrics,
      layoutDocument: () => presentationStore.getState().layoutDocument(),
      projectionRefreshCount: () => projectionRefreshCount,
      taskPatchCount: () => taskPatchCount,
      taskRowRenderCount: taskRowRenders,
      repairTaskWorktree,
      activateAgentAttention,
      reconnectTerminalAttachments: () => terminalPool.reconnectAttachments(),
      measureSelectedEcho: async (iterations) => {
        if (!selectedSession) throw new Error("no selected terminal");
        const frameSamples: number[] = [];
        let previous = performance.now();
        for (let index = 0; index < 30; index += 1) {
          await new Promise(requestAnimationFrame);
          const now = performance.now();
          if (index >= 5) frameSamples.push(now - previous);
          previous = now;
        }
        const samples: number[] = [];
        for (let index = 0; index < iterations; index += 1) samples.push(await terminalPool.measureEcho(selectedSession.id));
        terminalPool.clearInputLine(selectedSession.id);
        const percentile = (values: number[], value: number) => {
          const sorted = [...values].sort((left, right) => left - right);
          return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
        };
        return {
          frameIntervalMs: percentile(frameSamples, 0.5),
          samples,
          p50: percentile(samples, 0.5),
          p95: percentile(samples, 0.95),
          p99: percentile(samples, 0.99),
        };
      },
    };
    return () => { delete window.termloopDiagnostics; };
  }, [selectedSession?.id, selectedRuntimeEpoch]);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const scheduleRetry = (delay: number) => {
      if (retry || disposed) return;
      retry = setTimeout(() => {
        retry = undefined;
        void connect();
      }, delay);
    };
    const connect = async () => {
      await ensureLayoutsLoaded();
      try {
        await refreshProjection();
      } catch (error) {
        projectionStore.setConnection("connectionLost", error instanceof Error ? error.message : String(error));
        scheduleRetry(1_000);
        return;
      }
      if (disposed) return;
      if (presentationStore.getState().selectedProjectId === undefined && projectionStore.getSnapshot().projects.length === 0) {
        presentationStore.getState().openProjectDialog();
      }
    };
    void connect();
    const unsubscribe = onGatewayState((profileId, state) => {
      const sourceName = projectionStore.sourceName(profileId) ?? "Computer";
      if (state === "connectionLost") {
        projectionStore.setSourceConnection(profileId, sourceName, "offline", "Terminal connection lost — reconnecting");
      } else if (state === "gatewayProcessLost") {
        projectionStore.setSourceConnection(profileId, sourceName, "offline", "Terminal gateway restarted — reconnecting");
        terminalPool.reconnectAttachments(profileId);
      } else if (state === "connected") {
        terminalPool.reconnectAttachments(profileId);
        void refreshProjection().catch((error) => {
          projectionStore.setSourceConnection(profileId, sourceName, "offline", controlErrorMessage(error));
        });
      }
    });
    const unsubscribeConnection = onConnectionStatus((summary) => {
      projectionStore.setSourceConnection(summary.id, summary.name, summary.state, summary.message);
      if (summary.state === "connected") void refreshProjection();
    });
    const assistantRefresh = new AssistantRefreshThrottle(
      () => setAssistantRefreshToken((current) => current + 1),
      timeoutRefreshScheduler,
    );
    const unsubscribeProjection = onProjectionInvalidated(({ profileId, payload }) => {
      if (payload.topics.some((topic) => ["companion", "steward", "worker", "routine", "playbook", "session", "agentStatus"].includes(topic))) {
        assistantRefresh.request();
      }
      // The daemon takes and releases the hold on its own as agents come and
      // go, so the footer control follows its projection rather than assuming
      // its own last write is still current.
      if (payload.topics.includes("keepAwake")) {
        setKeepAwakeRefreshToken((current) => current + 1);
      }
      // Task Source observations and the Project-owned defaults used by import
      // confirmation are both read by the Task Sources page. Refetch either
      // projection without riding the whole-Project snapshot.
      if (payload.topics.includes("taskSource") || payload.topics.includes("project")) {
        setTaskSourceRefreshToken((current) => current + 1);
      }
      const gitHostIds = payload.topics.length === 1 && payload.topics[0] === "gitHost"
        ? payload.entityScopes?.find((scope) => scope.topic === "gitHost")?.ids
        : undefined;
      const taskIds = payload.topics.length === 1 && payload.topics[0] === "task"
        ? payload.entityScopes?.find((scope) => scope.topic === "task")?.ids
        : undefined;
      const branchCommitIds = payload.topics.length === 1 && payload.topics[0] === "branchCommit"
        ? payload.entityScopes?.find((scope) => scope.topic === "branchCommit")?.ids
        : undefined;
      const projectId = presentationStore.getState().selectedProjectId;
      const selectedProject = projectionStore.getSnapshot().projects.find((project) => project.id === projectId);
      const selectedSourceMatches = connectionProfileIdOf(selectedProject) === profileId;
      const refresh = selectedSourceMatches && gitHostIds && projectId
        ? refreshGitHostProjection(projectId, gitHostIds)
        : selectedSourceMatches && branchCommitIds && projectId ? refreshBranchCommitProjection(projectId, branchCommitIds)
        : selectedSourceMatches && taskIds ? refreshTaskProjection(taskIds) : refreshProjection();
      void refresh.catch((error) => {
        projectionStore.setConnection("connectionLost", controlErrorMessage(error));
        scheduleRetry(750);
      });
    });
    const unsubscribeAttention = onAgentAttentionActivated((sessionId) => {
      activateAgentAttention(sessionId);
    });
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      assistantRefresh.dispose();
      unsubscribe();
      unsubscribeConnection();
      unsubscribeProjection();
      unsubscribeAttention();
    };
  }, []);

  const bindTerminalHost = useCallback((sessionId: string, host: HTMLElement | null) => {
    if (host) void terminalPool.mount(sessionId, host);
    else terminalPool.unmount(sessionId);
  }, []);

  const selectProject = useCallback((projectId: string) => {
    presentationStore.getState().selectProject(projectId);
      void refreshProjection().catch((error) => projectionStore.setMessage(controlErrorMessage(error)));
  }, []);
  const selectSession = useCallback((sessionId: string) => {
    if (selectedProject) {
      presentationStore.getState().selectSession(selectedProject.id, sessionId);
      focusTerminalSoon(sessionId);
    }
  }, [selectedProject]);
  const navigateSession = useCallback((sessionId: string) => {
    if (selectedProject) presentationStore.getState().navigateSession(selectedProject.id, sessionId);
  }, [selectedProject]);
  const launchTerminal = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const session = await selectedSourceApi.terminalLaunch(selectedProject.id);
      await refreshProjection();
      presentationStore.getState().selectSession(selectedProject.id, session.id);
      focusTerminalSoon(session.id);
    } catch (error) {
      projectionStore.setMessage(controlErrorMessage(error));
    }
  }, [selectedProject, selectedSourceApi]);
  const launchAgent = useCallback(async (agentId: string) => {
    if (!selectedProject) return;
    const projectId = selectedProject.id;
    const capability = agentCapabilities.find((candidate) => candidate.agent_id === agentId);
    if (!capability?.available) return;
    let preset: OrdinaryAgentLaunchPreset;
    if (capability.quick_action_supported) {
      if (!isQuickActionAgentId(agentId)) return;
      const saved = readQuickActionPreset(agentId);
      if (!saved) return "configure" as const;
      preset = saved;
    } else {
      preset = defaultCapabilityLaunchPreset(capability);
    }
    try {
      const inspected = await selectedSourceApi.agentPreview(projectId, agentId, preset.model, preset.permission, preset.reasoning);
      const session = await selectedSourceApi.agentLaunch(projectId, agentId, inspected.launch_ticket);
      await refreshProjection();
      presentationStore.getState().selectSession(projectId, session.id);
      focusTerminalSoon(session.id);
      return undefined;
    } catch (error) {
      projectionStore.setMessage(controlErrorMessage(error));
      return undefined;
    }
  }, [agentCapabilities, selectedProject, selectedSourceApi]);
  const loadSessionHistory = useCallback(
    (projectId: string, force = false, fillCache = false) => sourceApiForProject(projectId).sessionHistoryList(projectId, force, fillCache),
    [],
  );
  const loadSessionHistoryPreview = useCallback(
    (projectId: string, sessionId: string) => sourceApiForProject(projectId).sessionHistoryPreview(projectId, sessionId),
    [],
  );
  const resumeHistorySession = useCallback(async (projectId: string, historyHandle: string) => {
    try {
      const api = sourceApiForProject(projectId);
      const inspected = await api.sessionHistoryPreviewResumeAgent(projectId, historyHandle);
      const session = await api.sessionHistoryResumeAgent(projectId, historyHandle, inspected.launch_ticket);
      await refreshProjection();
      presentationStore.getState().selectProject(projectId);
      presentationStore.getState().selectSession(projectId, session.id);
      focusTerminalSoon(session.id);
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const launchQuickAction = useCallback(async (projectId: string, agentId: string, model: string, permission: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max", prompt: string, attachmentIds: string[], launchTicket: string) => {
    try {
      const session = requireQuickActionSession(
        await sourceApiForProject(projectId).quickActionLaunch(projectId, agentId, model, permission, reasoning, prompt, attachmentIds, launchTicket),
        projectId,
      );
      await refreshProjection();
      presentationStore.getState().selectProject(projectId);
      presentationStore.getState().selectSession(projectId, session.id);
      focusTerminalSoon(session.id);
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const launchTaskTerminal = useCallback(async (taskId: string) => {
    try {
      const outcome = await sourceApiForTask(taskId).taskTerminalLaunch(taskId);
      if (!outcome.ok) {
        const message = taskLaunchFailureMessage(outcome);
        projectionStore.setMessage(message);
        return message;
      }
      const session = outcome.result;
      projectionStore.upsertSession(session);
      terminalPool.reconcile(projectionStore.getSnapshot().sessions);
      await refreshTaskProjection([taskId]);
      presentationStore.getState().selectProject(session.project_id);
      presentationStore.getState().selectSession(session.project_id, session.id);
      focusTerminalSoon(session.id);
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error); projectionStore.setMessage(message); return message;
    }
  }, []);
  const saveRunConfiguration = useCallback(async (
    params: RunConfigurationCreateParams | RunConfigurationUpdateParams,
  ): Promise<RunConfigurationDto | string> => {
    try {
      const result = "configurationId" in params
        ? await selectedSourceApi.runConfigurationUpdate(params)
        : await selectedSourceApi.runConfigurationCreate(params);
      await refreshProjection();
      return result.configuration;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, [selectedSourceApi]);
  const deleteRunConfiguration = useCallback(async (configurationId: string): Promise<string | undefined> => {
    try {
      await selectedSourceApi.runConfigurationDelete({
        configurationId,
        expectedRevision: projectionStore.getSnapshot().runStateRevision,
      });
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, [selectedSourceApi]);
  /// Improve-with-agent launch and immutable version history for settings.
  /// The Agent activates a new version only after the user tells it to apply.
  const settingsImprovement = useMemo(() => ({
    async start(target: SettingsImproverTarget, requested?: QuickActionAgentSelection, options?: { fresh?: boolean }): Promise<string | undefined> {
      const projectId = presentationStore.getState().selectedProjectId ?? "";
      if (!projectId) return "Open a Project first: the improver runs in its checkout.";
      try {
        const api = sourceApiForProject(projectId);
        const session = await resumeImproverOrLaunchFresh(
          api,
          projectionStore.getSnapshot().sessions,
          projectId,
          settingsImproverSessionTarget(target),
          undefined,
          async () => {
            const launch = requested ?? readLastQuickActionAgentSelection();
            const selection = {
              projectId,
              agentId: launch.agentId,
              model: launch.model,
              permission: launch.permission,
              reasoning: launch.reasoning,
              templateRef: target.kind === "skill" ? "builtin.improver.skill-definition" as const
                : target.kind === "prompt" ? "builtin.improver.prompt-asset" as const
                : "builtin.improver.mcp-tool-description" as const,
              bindings: target,
            };
            const inspected = await api.settingsImprovePreview(selection);
            return api.settingsImproveLaunch({ ...selection, launchTicket: inspected.launch_ticket });
          },
          options?.fresh ? { requested: true, retire: (previous) => retireImproverSession(previous.id) } : undefined,
        );
        await activateImproverSession(projectId, session);
        return undefined;
      } catch (error) {
        const message = controlErrorMessage(error);
        projectionStore.setMessage(message);
        return message;
      }
    },
    async versions(target: VersionedConfigurationTarget) {
      const projectId = presentationStore.getState().selectedProjectId ?? "";
      if (!projectId) return "Open a Project first.";
      try {
        return await sourceApiForProject(projectId).configurationVersionList({ projectId, ...target });
      } catch (error) {
        return controlErrorMessage(error);
      }
    },
    async restore(target: VersionedConfigurationTarget, version: ConfigurationVersionDto, activeVersionId: string | null): Promise<string | undefined> {
      const projectId = presentationStore.getState().selectedProjectId ?? "";
      if (!projectId) return "Open a Project first.";
      try {
        await sourceApiForProject(projectId).configurationVersionRestore({
          projectId,
          versionId: version.id,
          expectedActiveVersionId: activeVersionId,
        });
        await refreshProjection();
        return undefined;
      } catch (error) {
        const message = controlErrorMessage(error);
        projectionStore.setMessage(message);
        return message;
      }
    },
  }), []);
  const runImprovement = useMemo(() => {
    const templateRef = (target: RunConfigurationImproverTarget) =>
      target.configurationId
        ? "builtin.improver.run-configuration" as const
        : "builtin.improver.run-configuration-new" as const;
    return {
      async start(projectId: string, target: RunConfigurationImproverTarget, requested?: QuickActionAgentSelection, options?: { fresh?: boolean }): Promise<string | undefined> {
        try {
          const api = sourceApiForProject(projectId);
          const session = await resumeImproverOrLaunchFresh(
            api,
            projectionStore.getSnapshot().sessions,
            projectId,
            runImproverSessionTarget(target),
            legacyRunImproverIdentity(target),
            async () => {
              const launch = requested ?? readLastQuickActionAgentSelection();
              const selection = {
                projectId,
                agentId: launch.agentId,
                model: launch.model,
                permission: launch.permission,
                reasoning: launch.reasoning,
                templateRef: templateRef(target),
                bindings: target,
              };
              const inspected = await api.runConfigurationImprovePreview(selection);
              return api.runConfigurationImproveLaunch({
                ...selection,
                launchTicket: inspected.launch_ticket,
              });
            },
            options?.fresh ? { requested: true, retire: (previous) => retireImproverSession(previous.id) } : undefined,
          );
          await activateImproverSession(projectId, session);
          return undefined;
        } catch (error) {
          const message = controlErrorMessage(error);
          projectionStore.setMessage(message);
          return message;
        }
      },
      async versions(projectId: string, target: VersionedConfigurationTarget) {
        try {
          return await sourceApiForProject(projectId).configurationVersionList({ projectId, ...target });
        } catch (error) {
          return controlErrorMessage(error);
        }
      },
      async restore(projectId: string, _target: VersionedConfigurationTarget, versionId: string, expectedActiveVersionId: string | null) {
        try {
          const result = await sourceApiForProject(projectId).configurationVersionRestore({
            projectId,
            versionId,
            expectedActiveVersionId,
          });
          await refreshProjection();
          return result;
        } catch (error) {
          const message = controlErrorMessage(error);
          projectionStore.setMessage(message);
          return message;
        }
      },
    };
  }, []);
  /// Both run launches differ only in which checkout they name, so the whole
  /// post-launch composition — auto-open intent, projection, focus — is shared.
  const admitRunSession = useCallback(async (
    outcome: Awaited<ReturnType<typeof desktopApi.taskStartRun>>,
    configurationId: string,
  ): Promise<string | undefined> => {
    if (!outcome.ok) {
      const message = taskLaunchFailureMessage(outcome);
      projectionStore.setMessage(message);
      return message;
    }
    const session = outcome.result;
    const configuration = projectionStore.getSnapshot().runConfigurations
      .find((candidate) => candidate.id === configurationId);
    if (configuration?.autoOpenFirstUrl) {
      pendingRunAutoOpenSessionIds.current.add(session.id);
    }
    projectionStore.upsertSession(session);
    terminalPool.reconcile(projectionStore.getSnapshot().sessions);
    await refreshProjection();
    presentationStore.getState().selectProject(session.project_id);
    presentationStore.getState().selectSession(session.project_id, session.id);
    focusTerminalSoon(session.id);
    return undefined;
  }, []);
  const launchProjectRun = useCallback(async (
    projectId: string,
    configurationId: string,
    restart: boolean,
    forceSetup = false,
  ): Promise<string | undefined> => {
    try {
      const params = { projectId, configurationId, forceSetup };
      return await admitRunSession(
        restart
          ? await sourceApiForProject(projectId).projectRestartRun(params)
          : await sourceApiForProject(projectId).projectStartRun(params),
        configurationId,
      );
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, [admitRunSession]);
  const launchTaskRun = useCallback(async (
    taskId: string,
    configurationId: string,
    restart: boolean,
    forceSetup = false,
  ): Promise<string | undefined> => {
    try {
      const params = { taskId, configurationId, forceSetup };
      const outcome = restart
        ? await sourceApiForTask(taskId).taskRestartRun(params)
        : await sourceApiForTask(taskId).taskStartRun(params);
      return await admitRunSession(outcome, configurationId);
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, [admitRunSession]);
  const launchTaskAgent = useCallback(async (
    taskId: string,
    agentId: string,
    model?: string,
    reasoning?: AgentCapabilityDto["reasoning"][number],
    kickoffMessage?: string,
  ) => {
    const capability = agentCapabilities.find((candidate) => candidate.agent_id === agentId);
    if (!capability?.available) return "The selected agent CLI is unavailable.";
    const preset = isQuickActionAgentId(agentId)
      ? readTaskAgentPreset(agentId)
      : defaultCapabilityLaunchPreset(capability);
    try {
      const api = sourceApiForTask(taskId);
      const inspected = await api.taskAgentPreview(
        taskId,
        agentId,
        model ?? preset.model,
        preset.permission,
        reasoning ?? preset.reasoning,
        kickoffMessage,
      );
      if (!inspected.ok) {
        const message = taskLaunchFailureMessage(inspected);
        projectionStore.setMessage(message);
        return message;
      }
      const outcome = await api.taskAgentLaunch(taskId, agentId, inspected.result.launch_ticket);
      if (!outcome.ok) {
        const message = taskLaunchFailureMessage(outcome);
        projectionStore.setMessage(message);
        return message;
      }
      const session = outcome.result;
      projectionStore.upsertSession(session);
      terminalPool.reconcile(projectionStore.getSnapshot().sessions);
      await refreshTaskProjection([taskId]);
      presentationStore.getState().selectProject(session.project_id);
      presentationStore.getState().selectSession(session.project_id, session.id);
      focusTerminalSoon(session.id);
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, [agentCapabilities]);
  const inspectTaskWorktreeRepair = useCallback(async (taskId: string, candidatePath: string) => {
    const outcome = await sourceApiForTask(taskId).taskInspectWorktreeRepair(taskId, candidatePath);
    if (outcome.ok) return outcome.result;
    throw new Error(taskRepairError(outcome));
  }, []);
  /// The rail raises one close intent. Live Sessions are terminated first;
  /// Core then retains Agent descriptors in Deleted and hard-closes Terminals.
  const dismissSession = useCallback(async (sessionId: string) => {
    const session = projectionStore.getSnapshot().sessions.find((value) => value.id === sessionId);
    const command = session && sessionDismissCommand(session);
    // The row carries no confirmation step, so a second click during the first
    // round trip would send the command twice and report the echo as a Session
    // that is "no longer running".
    if (!command || dismissingSessions.has(sessionId)) return;
    dismissingSessions.add(sessionId);
    let failure: string | undefined;
    try {
      await dismissSessionDescriptor(sourceApiForSession(sessionId), session);
    } catch (error) {
      failure = sessionDismissErrorMessage(error);
    } finally {
      dismissingSessions.delete(sessionId);
      // Refresh either way: a Session the daemon rejected as unknown is already
      // gone, and only the refresh takes its row out of the rail. The refresh
      // installs a whole new projection and drops its message with it, so the
      // failure is stated after it rather than before.
      try {
        await refreshProjection();
      } catch (error) {
        failure ??= controlErrorMessage(error);
      }
      if (failure) projectionStore.setMessage(failure);
    }
  }, []);
  const resumeSession = useCallback(async (sessionId: string) => {
    let failure: string | undefined;
    try {
      const api = sourceApiForSession(sessionId);
      const session = projectionStore.getSnapshot().sessions.find((candidate) => candidate.id === sessionId);
      if (session?.resume_failure_reason === "providerHistoryDamaged") {
        const outcome = await fixProviderHistoryAndRetry(api, session);
        failure = outcome.failure;
      } else {
        await retryAgentSession(api, sessionId);
      }
    } catch (error) {
      failure = controlErrorMessage(error);
    }
    try {
      await refreshProjection();
    } catch (error) {
      failure ??= controlErrorMessage(error);
    }
    if (failure) projectionStore.setMessage(failure);
  }, []);
  const restartAgent = useCallback(async (sessionId: string) => {
    let failure: string | undefined;
    try {
      const outcome = await sourceApiForSession(sessionId).sessionRestartAgent(sessionId);
      if (!outcome.ok) failure = outcome.message;
    } catch (error) {
      failure = controlErrorMessage(error);
    }
    try {
      await refreshProjection();
    } catch (error) {
      failure ??= controlErrorMessage(error);
    }
    if (failure) projectionStore.setMessage(failure);
  }, []);
  const forkSession = useCallback(async (sessionId: string) => {
    let failure: string | undefined;
    try {
      const outcome = await sourceApiForSession(sessionId).sessionForkAgent(sessionId);
      if (!outcome.ok) {
        const requiresRepair = agentForkRequiresProviderHistoryRepair(outcome);
        failure = agentForkErrorMessage(outcome);
        await refreshProjection();
        if (!requiresRepair) projectionStore.setMessage(failure);
        return requiresRepair;
      }
      const session = outcome.result;
      await refreshProjection();
      presentationStore.getState().selectProject(session.project_id);
      presentationStore.getState().selectSession(session.project_id, session.id);
      focusTerminalSoon(session.id);
      return false;
    } catch (error) {
      failure ??= controlErrorMessage(error);
      try {
        await refreshProjection();
      } catch (refreshError) {
        failure ??= controlErrorMessage(refreshError);
      }
      projectionStore.setMessage(failure);
      return false;
    }
  }, []);
  const repairProviderHistory = useCallback(async (sessionId: string) => {
    const api = sourceApiForSession(sessionId);
    let failure: string | undefined;
    try {
      const session = projectionStore.getSnapshot().sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return "This Session is no longer available.";
      const outcome = await executeProviderHistoryRepair(api, session);
      failure = outcome.failure;
      if (outcome.success) projectionStore.setMessage(outcome.success);
    } catch (error) {
      failure = controlErrorMessage(error);
    }
    try {
      await refreshProjection();
    } catch (error) {
      failure ??= controlErrorMessage(error);
    }
    return failure;
  }, []);
  const requestAgentAskTo = useCallback(async (sessionId: string, targetAgentId: "claude" | "codex") => {
    try {
      await sourceApiForSession(sessionId).sessionRequestAskTo(sessionId, targetAgentId);
      const source = projectionStore.getSnapshot().sessions.find((session) => session.id === sessionId);
      if (source) {
        presentationStore.getState().selectProject(source.project_id);
        presentationStore.getState().selectSession(source.project_id, source.id);
        focusTerminalSoon(source.id);
      }
    } catch (error) {
      projectionStore.setMessage(`Ask-To request was not sent: ${controlErrorMessage(error)}`);
    }
  }, []);
  const requestAgentHandoverTo = useCallback(async (sessionId: string, targetSessionId: string) => {
    try {
      await sourceApiForSession(sessionId).sessionRequestHandoverTo(sessionId, targetSessionId);
      const source = projectionStore.getSnapshot().sessions.find((session) => session.id === sessionId);
      if (source) {
        presentationStore.getState().selectProject(source.project_id);
        presentationStore.getState().selectSession(source.project_id, source.id);
        focusTerminalSoon(source.id);
      }
    } catch (error) {
      projectionStore.setMessage(`Handover request was not sent: ${controlErrorMessage(error)}`);
    }
  }, []);
  const closeSession = useCallback(async (sessionId: string) => {
    await dismissSession(sessionId);
  }, [dismissSession]);
  const renameSession = useCallback(async (sessionId: string, name: string | null) => {
    try {
      await sourceApiForSession(sessionId).sessionRename(sessionId, name);
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const createProject = useCallback(async (profileId: string, name: string, folderPath: string) => {
    const project = await desktopApi.source(profileId).projectCreate(name, folderPath);
    presentationStore.getState().selectProject(project.id);
    await refreshProjection();
  }, []);
  const updateProject = useCallback(async (projectId: string, name: string, folderPath: string) => {
    try {
      await sourceApiForProject(projectId).projectUpdate(projectId, name, folderPath);
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const deleteProject = useCallback(async (projectId: string) => {
    try {
      const response = await sourceApiForProject(projectId).projectDelete(projectId);
      if (!response.ok) {
        const message = projectDeleteErrorMessage(response.error);
        projectionStore.setMessage(message);
        return message;
      }
      await refreshProjection();
      if (projectionStore.getSnapshot().projects.length === 0) {
        presentationStore.getState().openProjectDialog();
      }
      return undefined;
    } catch (error) {
      const message = projectDeleteErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const createTask = useCallback(async (title: string, brief: string | null) => {
    if (!selectedProject) return { failure: "Select a Project first." };
    try {
      const task = await selectedSourceApi.taskCreate(selectedProject.id, title, brief);
      await refreshProjection();
      return { taskId: task.id };
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return { failure: message };
    }
  }, [selectedProject, selectedSourceApi]);
  const updateTask = useCallback(async (taskId: string, title: string, brief: string | null) => {
    try {
      const current = projectionStore.getSnapshot().tasks.find((task) => task.id === taskId);
      if (!current) return "Task is no longer available.";
      const api = sourceApiForTask(taskId);
      if (current.title !== title.trim()) await api.taskRename(taskId, title);
      if ((current.brief ?? null) !== (brief?.trim() || null)) await api.taskUpdateBrief(taskId, brief);
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const bindTaskBranch = useCallback(async (taskId: string, repositoryPath: string, branchName: string) => {
    try {
      const result = await sourceApiForTask(taskId).taskBindBranch(taskId, repositoryPath, branchName);
      const message = taskBindBranchFailureMessage(result);
      if (message) {
        projectionStore.setMessage(message);
        return message;
      }
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const listProjectLocalBranches = useCallback(async (projectId: string): Promise<ProjectLocalBranchListResult> => {
    try {
      return await sourceApiForProject(projectId).projectListLocalBranches(projectId);
    } catch (error) {
      throw new Error(controlErrorMessage(error));
    }
  }, []);
  const provisionTaskWorktree = useCallback(async (params: TaskProvisionWorktreeParams) => {
    try {
      const currentTask = projectionStore.getSnapshot().tasks.find((task) => task.id === params.taskId);
      const failedOperationId = dismissibleFailedProvisioningOperationId(
        currentTask?.worktree_provisioning,
      );
      if (failedOperationId) {
        await sourceApiForTask(params.taskId).taskDismissWorktreeProvisioning(params.taskId, failedOperationId);
      }
      const result = await sourceApiForTask(params.taskId).taskProvisionWorktree(params);
      const message = taskProvisionWorktreeFailureMessage(result);
      if (message) {
        await refreshProjection();
        projectionStore.setMessage(message);
        return message;
      }
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const dismissTaskWorktreeProvisioning = useCallback(async (taskId: string, operationId: string) => {
    try {
      await sourceApiForTask(taskId).taskDismissWorktreeProvisioning(taskId, operationId);
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const inspectTaskWorktreeCleanup = useCallback(
    (taskId: string) => sourceApiForTask(taskId).taskInspectWorktreeCleanup(taskId),
    [],
  );
  const cleanupTaskWorktree = useCallback(async (params: TaskCleanupWorktreeParams) => {
    try {
      const result = await sourceApiForTask(params.taskId).taskCleanupWorktree(params);
      if (result.outcome === "running") {
        await refreshProjection();
        return `Worktree cleanup operation ${result.cleanup?.operation_id ?? params.operationId} is still running.`;
      }
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const setTaskClosed = useCallback(async (taskId: string, closed: boolean) => {
    try {
      if (closed) await sourceApiForTask(taskId).taskClose(taskId);
      else await sourceApiForTask(taskId).taskReopen(taskId);
      await refreshProjection();
    } catch (error) {
      projectionStore.setMessage(controlErrorMessage(error));
    }
  }, []);
  const listArchivedTasks = useCallback(
    (projectId: string) => sourceApiForProject(projectId).taskList(projectId, undefined, "archived"),
    [],
  );
  const inspectTaskArchive = useCallback(
    (taskId: string) => sourceApiForTask(taskId).taskInspectArchive(taskId),
    [],
  );
  const archiveTask = useCallback(async (taskId: string, archiveTicket: string) => {
    try {
      await sourceApiForTask(taskId).taskArchive(taskId, archiveTicket);
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const restoreTask = useCallback(async (taskId: string) => {
    let failure: string | undefined;
    try {
      await sourceApiForTask(taskId).taskRestore(taskId);
      await refreshProjection();
    } catch (error) {
      failure = controlErrorMessage(error);
    }
    if (failure) projectionStore.setMessage(failure);
    return failure;
  }, []);
  const listArchivedSessions = useCallback(
    (projectId: string) => sourceApiForProject(projectId).sessionListArchived(projectId),
    [],
  );
  const listDeletedSessions = useCallback(
    (projectId: string) => sourceApiForProject(projectId).sessionListDeleted(projectId),
    [],
  );
  const archiveSession = useCallback(async (sessionId: string) => {
    try {
      const api = sourceApiForSession(sessionId);
      const preview = await api.sessionInspectArchive(sessionId);
      if (!preview.can_archive) {
        const message = `Agent cannot be archived: ${preview.blocker ?? "archive refused"}.`;
        projectionStore.setMessage(message);
        return message;
      }
      const label = sessionLabel(preview.session);
      if (!window.confirm(`Archive ${label}?\n\nIts process will stop. TermLoop will retain the resumable conversation pointer so the same Agent Session can be restored later.`)) {
        return "Archive cancelled.";
      }
      await api.sessionArchive(sessionId, preview.archive_ticket);
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const restoreArchivedSession = useCallback(async (sessionId: string) => {
    try {
      await sourceApiForSession(sessionId).sessionRestoreArchived(sessionId);
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const deleteArchivedSession = useCallback(async (sessionId: string) => {
    if (!window.confirm("Delete this archived Agent?\n\nTermLoop will permanently forget this Session and its recovery pointer. Its provider-side conversation, Tasks, worktrees, branches, and files will not be deleted.")) {
      return "Delete cancelled.";
    }
    try {
      await sourceApiForSession(sessionId).sessionDeleteArchived(sessionId);
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const restoreDeletedSession = useCallback(async (sessionId: string) => {
    try {
      await sourceApiForSession(sessionId).sessionRestoreDeleted(sessionId);
      await refreshProjection();
      return undefined;
    } catch (error) {
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return message;
    }
  }, []);
  const deleteTaskAndWorktree = useCallback(async (
    taskId: string,
    review?: TaskDeleteWorktreeReview,
  ): Promise<TaskDeleteWorktreeResult> => {
    setDeletingTaskIds((current) => current.has(taskId) ? current : new Set(current).add(taskId));
    try {
      const api = sourceApiForTask(taskId);
      const initialTask = projectionStore.getSnapshot().tasks.find((task) => task.id === taskId);
      if (!initialTask) return { status: "completed" };
      if (initialTask.worktree && !review) {
        return { status: "failed", message: "Inspect the worktree before removing it." };
      }
      let currentTask: Task | undefined = initialTask;
      let parkedForClose = false;
      if (initialTask.worktree) {
        const archivePreview = await api.taskInspectArchive(taskId);
        if (!archivePreview.can_archive) {
          return {
            status: "failed",
            message: `Task Agents could not be parked safely: ${archivePreview.blockers.join(", ") || "archive refused"}.`,
          };
        }
        const archived = await api.taskArchive(taskId, archivePreview.archive_ticket);
        currentTask = archived.task;
        parkedForClose = true;
        await refreshProjection();
      }
      const refresh = async () => {
        await refreshProjection();
        currentTask = parkedForClose
          ? (await api.taskList(initialTask.project_id, [taskId], "archived"))[0]
            ?? projectionStore.getSnapshot().tasks.find((task) => task.id === taskId)
          : projectionStore.getSnapshot().tasks.find((task) => task.id === taskId);
      };
      const result = await orchestrateTaskDelete({
        taskId,
        review,
        currentTask: () => currentTask,
        currentSession: (sessionId) => projectionStore.getSnapshot().sessions.find((session) => session.id === sessionId),
        inspect: () => api.taskInspectWorktreeCleanup(taskId),
        refresh,
        terminate: (sessionId) => api.sessionTerminate(sessionId),
        close: (sessionId) => api.sessionClose(sessionId),
        cleanup: (params) => api.taskCleanupWorktree(params),
        forgetStale: (params) => api.taskForgetStaleWorktree(params),
        discardStale: (params) => api.taskDiscardStaleWorktree(params),
        deleteTask: () => parkedForClose
          ? api.taskFinalizeClosedWorktreeRemoval(taskId)
          : api.taskDelete(taskId),
        completion: parkedForClose ? "close" : "delete",
        freshId: () => globalThis.crypto.randomUUID(),
        errorMessage: controlErrorMessage,
      });
      const finalResult = parkedForClose && result.status !== "completed"
        ? { ...result, message: `Task and Agents remain safely parked in Archived. ${result.message}` }
        : result;
      if (finalResult.message) projectionStore.setMessage(finalResult.message);
      return finalResult;
    } catch (error) {
      try {
        await refreshProjection();
      } catch {}
      const message = controlErrorMessage(error);
      projectionStore.setMessage(message);
      return { status: "failed", message };
    } finally {
      setDeletingTaskIds((current) => {
        if (!current.has(taskId)) return current;
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  }, []);
  const deleteArchivedTaskAndWorktree = useCallback(async (
    task: Task,
    review?: TaskDeleteWorktreeReview,
  ): Promise<TaskDeleteWorktreeResult> => {
    let currentTask: Task | undefined = task;
    const api = desktopApi.source(connectionProfileIdOf(task));
    setDeletingTaskIds((current) => current.has(task.id) ? current : new Set(current).add(task.id));
    try {
      const refresh = async () => {
        await refreshProjection();
        currentTask = (await api.taskList(task.project_id, [task.id], "archived"))[0];
      };
      const result = await orchestrateTaskDelete({
        taskId: task.id,
        review,
        currentTask: () => currentTask,
        currentSession: (sessionId) => projectionStore.getSnapshot().sessions.find((session) => session.id === sessionId),
        inspect: () => api.taskInspectWorktreeCleanup(task.id),
        refresh,
        terminate: (sessionId) => api.sessionTerminate(sessionId),
        close: (sessionId) => api.sessionClose(sessionId),
        cleanup: (params) => api.taskCleanupWorktree(params),
        forgetStale: (params) => api.taskForgetStaleWorktree(params),
        discardStale: (params) => api.taskDiscardStaleWorktree(params),
        deleteTask: () => api.taskDeleteArchived(task.id),
        freshId: () => globalThis.crypto.randomUUID(),
        errorMessage: controlErrorMessage,
      });
      if (result.message) projectionStore.setMessage(result.message);
      return result;
    } finally {
      setDeletingTaskIds((current) => {
        if (!current.has(task.id)) return current;
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  }, []);
  const openSessionInSplit = useCallback((sessionId: string, direction: SplitDirection) => {
    if (!selectedProject) return;
    if (!presentationStore.getState().openSessionInSplit(selectedProject.id, sessionId, direction)) {
      projectionStore.setMessage("A layout can contain at most 8 panes.");
      return;
    }
    focusTerminalSoon(sessionId);
  }, [selectedProject]);
  const openSessionInSplitAtPane = useCallback((sessionId: string, paneId: string, direction: SplitDirection, placement: SplitPlacement) => {
    if (!selectedProject) return false;
    const opened = presentationStore.getState().openSessionInSplitAtPane(selectedProject.id, paneId, sessionId, direction, placement);
    if (!opened) {
      projectionStore.setMessage("A layout can contain at most 8 panes.");
      return false;
    }
    focusTerminalSoon(sessionId);
    return true;
  }, [selectedProject]);
  const splitActivePane = useCallback((direction: SplitDirection) => {
    if (!selectedProject) return;
    if (!presentationStore.getState().splitActivePane(selectedProject.id, direction)) {
      projectionStore.setMessage("A layout can contain at most 8 panes.");
    }
  }, [selectedProject]);
  const focusPane = useCallback((paneId: string) => {
    if (!selectedProject) return;
    presentationStore.getState().focusPane(selectedProject.id, paneId);
    const sessionId = presentationStore.getState().selectedSessionByProject[selectedProject.id];
    if (sessionId) focusTerminalSoon(sessionId);
  }, [selectedProject]);
  const focusRelativePane = useCallback((offset: -1 | 1) => {
    if (!selectedProject) return;
    presentationStore.getState().focusRelativePane(selectedProject.id, offset);
    const sessionId = presentationStore.getState().selectedSessionByProject[selectedProject.id];
    if (sessionId) focusTerminalSoon(sessionId);
  }, [selectedProject]);
  const resizeLayoutSplit = useCallback((splitId: string, ratio: number) => {
    if (selectedProject) presentationStore.getState().resizeSplit(selectedProject.id, splitId, ratio);
  }, [selectedProject]);
  const closePane = useCallback((paneId: string) => {
    if (selectedProject) presentationStore.getState().closePane(selectedProject.id, paneId);
  }, [selectedProject]);
  const clearPane = useCallback((paneId: string) => {
    if (selectedProject) presentationStore.getState().clearPane(selectedProject.id, paneId);
  }, [selectedProject]);
  const reorderSession = useCallback((sessionId: string, targetSessionId: string, placement: "before" | "after") => {
    if (!selectedProject) return false;
    return presentationStore.getState().reorderSession(selectedProject.id, sessionId, targetSessionId, placement);
  }, [selectedProject]);
  const groupAgentSessions = useCallback((sessionId: string, targetSessionId: string) => {
    if (!selectedProject) return false;
    return presentationStore.getState().groupAgentSessions(selectedProject.id, sessionId, targetSessionId);
  }, [selectedProject]);
  const renameAgentGroup = useCallback((sessionId: string, name: string) => {
    if (!selectedProject) return false;
    return presentationStore.getState().renameAgentGroup(selectedProject.id, sessionId, name);
  }, [selectedProject]);
  const ungroupAgentGroup = useCallback((sessionId: string) => {
    if (!selectedProject) return false;
    return presentationStore.getState().ungroupAgentGroup(selectedProject.id, sessionId);
  }, [selectedProject]);
  const detachAgentRelationship = useCallback((sessionId: string) => {
    if (!selectedProject) return false;
    return presentationStore.getState().detachAgentRelationship(selectedProject.id, sessionId);
  }, [selectedProject]);
  const detachedRelationshipSessionIds = useMemo(
    () => new Set(selectedProject ? presentation.detachedAgentRelationshipsByProject[selectedProject.id] ?? [] : []),
    [presentation.detachedAgentRelationshipsByProject, selectedProject],
  );
  const openExternal = useCallback(async (url: string, runSessionId?: string) => {
    try {
      const api = runSessionId ? sourceApiForSession(runSessionId) : selectedSourceApi;
      await api.openExternal(url, runSessionId);
    } catch (error) {
      projectionStore.setMessage(`Link could not be opened: ${controlErrorMessage(error)}`);
    }
  }, [selectedSourceApi]);
  const sendTaskReviewNotes = useCallback(async (taskId: string, sessionId: string, message: string) => {
    if (reviewMessageByteLength(message) > MAX_CHANGE_REVIEW_MESSAGE_BYTES) {
      return "Review message exceeds the 64 KiB safety limit.";
    }
    const snapshot = projectionStore.getSnapshot();
    const task = snapshot.tasks.find((value) => value.id === taskId);
    if (!task) return "The selected Task is no longer available.";
    const target = taskReviewAgentSessions(task, snapshot.sessions).find((session) => session.id === sessionId);
    if (!target) return "The selected agent is no longer active in this Task.";
    const runtimeEpoch = target.runtime_epoch;
    presentationStore.getState().selectProject(target.project_id);
    presentationStore.getState().selectSession(target.project_id, target.id);
    await afterTwoFrames();
    const current = projectionStore.getSnapshot();
    const currentTask = current.tasks.find((value) => value.id === taskId);
    const currentTarget = currentTask
      ? taskReviewAgentSessions(currentTask, current.sessions).find((session) => session.id === sessionId)
      : undefined;
    if (!currentTarget || currentTarget.runtime_epoch !== runtimeEpoch) {
      return "The selected agent changed before the notes could be sent.";
    }
    try {
      await terminalPool.submitInput(sessionId, terminalReviewSubmission(message));
      focusTerminalSoon(sessionId);
      return undefined;
    } catch (error) {
      return `Review notes were not sent: ${error instanceof Error ? error.message : String(error)}`;
    }
  }, []);

  const sendProjectReviewNotes = useCallback(async (projectId: string, sessionId: string, message: string) => {
    if (reviewMessageByteLength(message) > MAX_CHANGE_REVIEW_MESSAGE_BYTES) {
      return "Review message exceeds the 64 KiB safety limit.";
    }
    const snapshot = projectionStore.getSnapshot();
    const target = snapshot.sessions.find((session) =>
      session.id === sessionId
      && session.project_id === projectId
      && session.kind === "Agent"
      && isLiveSession(session)
    );
    if (!target) return "The selected Project agent is no longer active.";
    const runtimeEpoch = target.runtime_epoch;
    presentationStore.getState().selectProject(projectId);
    presentationStore.getState().selectSession(projectId, target.id);
    await afterTwoFrames();
    const currentTarget = projectionStore.getSnapshot().sessions.find((session) =>
      session.id === sessionId
      && session.project_id === projectId
      && session.kind === "Agent"
      && isLiveSession(session)
    );
    if (!currentTarget || currentTarget.runtime_epoch !== runtimeEpoch) {
      return "The selected agent changed before the notes could be sent.";
    }
    try {
      await terminalPool.submitInput(sessionId, terminalReviewSubmission(message));
      focusTerminalSoon(sessionId);
      return undefined;
    } catch (error) {
      return `Review notes were not sent: ${error instanceof Error ? error.message : String(error)}`;
    }
  }, []);

  /// Improve-with-agent for editable assistant prompts and the Playbook. The launch is
  /// inspected first and redeemed by ticket, exactly like every other agent
  /// launch here; the delivered instructions come from the daemon's visible
  /// template, so the renderer composes no prompt of its own. The Agent saves
  /// an immutable version only after the user confirms in the Agent chat.
  const promptImprovement = useMemo(() => {
    const templateRef = (target: AssistantPromptImproverTarget) =>
      target.surface === "stewardInstructions" ? "builtin.improver.steward-instructions" as const
      : target.surface === "workerInstructions" ? "builtin.improver.worker-instructions" as const
      : target.surface === "routineInstructions" ? "builtin.improver.routine-instructions" as const
      : target.surface === "routineBuilder" ? "builtin.builder.routine" as const
      : "builtin.builder.playbook" as const;
    // Bind every version read/write to the Project that owns this panel.
    // Reading the mutable global selection inside a polling callback can race
    // a projection refresh or a same-folder Project switch and silently ask
    // the wrong Project for the version history shown on this panel.
    const projectId = assistantProjectId;
    const api = selectedSourceApi;
    return {
      async start(target: AssistantPromptImproverTarget, requested?: QuickActionAgentSelection, options?: { fresh?: boolean }): Promise<string | undefined> {
        try {
          const session = await resumeImproverOrLaunchFresh(
            api,
            projectionStore.getSnapshot().sessions,
            projectId,
            assistantImproverSessionTarget(target),
            () => legacyAssistantImproverIdentity(projectId, target),
            async () => {
              const launch = requested ?? readLastQuickActionAgentSelection();
              const selection = {
                projectId,
                agentId: launch.agentId,
                model: launch.model,
                permission: launch.permission,
                reasoning: launch.reasoning,
                templateRef: templateRef(target),
                bindings: target,
              };
              const inspected = await api.assistantPromptImprovePreview(selection);
              return api.assistantPromptImproveLaunch({
                ...selection,
                launchTicket: inspected.launch_ticket,
              });
            },
            options?.fresh ? { requested: true, retire: (previous) => retireImproverSession(previous.id) } : undefined,
          );
          rememberPromptImproverSession(projectId, target, session.id);
          await activateImproverSession(projectId, session);
          return undefined;
        } catch (error) {
          const message = controlErrorMessage(error);
          projectionStore.setMessage(message);
          return message;
        }
      },
      async versions(target: VersionedConfigurationTarget) {
        try {
          return await api.configurationVersionList({ projectId, ...target });
        } catch (error) {
          return controlErrorMessage(error);
        }
      },
      async restore(target: VersionedConfigurationTarget, version: import("@termloop/contract/current").ConfigurationVersionDto, activeVersionId: string | null): Promise<string | undefined> {
        try {
          await api.configurationVersionRestore({
            projectId,
            versionId: version.id,
            expectedActiveVersionId: activeVersionId,
          });
          await refreshProjection();
          return undefined;
        } catch (error) {
          const message = controlErrorMessage(error);
          projectionStore.setMessage(message);
          return message;
        }
      },
    };
  }, [assistantProjectId, selectedSourceApi]);
  const taskSourceActions: TaskSourceActions = useMemo(() => ({
    list: (projectId: string) => selectedSourceApi.taskSourceList({ projectId }),
    getProjectAutomation: (projectId: string) => selectedSourceApi.projectTaskAutomationGet(projectId),
    setProjectAutomation: selectedSourceApi.projectTaskAutomationSet,
    listBoards: selectedSourceApi.taskSourceBoardList,
    listStoredBoards: selectedSourceApi.taskSourceBoardListStored,
    listStatuses: selectedSourceApi.taskSourceStatusList,
    listStoredStatuses: selectedSourceApi.taskSourceStatusListStored,
    create: selectedSourceApi.taskSourceCreate,
    update: selectedSourceApi.taskSourceUpdate,
    setCredentials: selectedSourceApi.taskSourceConnect,
    delete: selectedSourceApi.taskSourceDelete,
    refresh: selectedSourceApi.taskSourceRefresh,
    listCandidates: (sourceId: string) => selectedSourceApi.taskSourceCandidateList({ sourceId }),
    importCandidate: selectedSourceApi.taskSourceCandidateImport,
    ignoreCandidate: selectedSourceApi.taskSourceCandidateIgnore,
    unignoreCandidate: selectedSourceApi.taskSourceCandidateUnignore,
  }), [selectedSourceApi]);
  const assistantActions = {
    getConfiguration: () => selectedSourceApi.stewardConfigurationGet(assistantProjectId),
    setConfiguration: (agentId: "claude" | "codex", model: string, permission: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max", enabled: boolean, systemPrompt: string, expectedRevision: number) =>
      selectedSourceApi.stewardConfigurationSet({ projectId: assistantProjectId, agentId, model, permission, reasoning, enabled, systemPrompt, expectedRevision }),
    deleteConfiguration: (expectedRevision: number) => selectedSourceApi.stewardConfigurationDelete({
      projectId: assistantProjectId,
      expectedRevision,
    }),
    listTranscript: (beforeSequence?: number) => selectedSourceApi.companionTranscriptList({
      projectId: assistantProjectId,
      limit: 100,
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
    }),
    appendMessage: (content: string) => selectedSourceApi.companionTranscriptAppend({ projectId: assistantProjectId, content }),
    respondToProposal: (proposalMessageId: string, decision: "approve" | "decline") => selectedSourceApi.companionProposalRespond({
      projectId: assistantProjectId,
      proposalMessageId,
      decision,
    }),
    acceptSuggestion: (suggestionMessageId: string) => selectedSourceApi.companionSuggestionAccept({
      projectId: assistantProjectId,
      suggestionMessageId,
    }),
    clearTranscript: (expectedRevision: number) => selectedSourceApi.companionTranscriptClear({ projectId: assistantProjectId, expectedRevision }),
    listWorkers: () => selectedSourceApi.workerConfigurationList({ projectId: assistantProjectId }),
    createWorker: selectedSourceApi.workerConfigurationCreate,
    updateWorker: selectedSourceApi.workerConfigurationUpdate,
    deleteWorker: (workerId: string, expectedRevision: number) => selectedSourceApi.workerConfigurationDelete({ workerId, expectedRevision }),
    listRoutines: () => selectedSourceApi.routineConfigurationList({ projectId: assistantProjectId }),
    createRoutine: selectedSourceApi.routineConfigurationCreate,
    updateRoutine: selectedSourceApi.routineConfigurationUpdate,
    updateRoutineContext: (routineId: string, contextMarkdown: string, expectedContextRevision: number, expectedRevision: number) => selectedSourceApi.routineContextUpdate({ routineId, contextMarkdown, expectedContextRevision, expectedRevision }),
    deleteRoutine: (routineId: string, expectedRevision: number) => selectedSourceApi.routineConfigurationDelete({ routineId, expectedRevision }),
    listRoutineRuntime: () => selectedSourceApi.routineRuntimeList({ projectId: assistantProjectId }),
    runRoutineNow: (routineId: string, taskId?: string) => selectedSourceApi.routineRunNow({
      routineId,
      ...(taskId ? { taskId } : {}),
    }),
    getPlaybook: () => selectedSourceApi.playbookGet(assistantProjectId),
    getPlaybookRuntime: () => selectedSourceApi.playbookRuntime(assistantProjectId),
    setPlaybookTaskPosition: selectedSourceApi.playbookTaskPositionSet,
    updatePlaybook: selectedSourceApi.playbookUpdate,
    promptImprovement,
    restartSteward: async (): Promise<string | null> => {
      const current = await selectedSourceApi.stewardConfigurationGet(assistantProjectId);
      if (!current.configuration?.enabled) return null;
      if (current.configuration.executorSessionId) {
        await selectedSourceApi.sessionTerminate(current.configuration.executorSessionId);
      }
      const latest = await selectedSourceApi.stewardConfigurationGet(assistantProjectId);
      await selectedSourceApi.stewardConfigurationSet({
        projectId: assistantProjectId,
        agentId: latest.configuration?.agentId ?? current.configuration.agentId,
        model: latest.configuration?.model ?? current.configuration.model,
        permission: latest.configuration?.permission ?? current.configuration.permission,
        reasoning: latest.configuration?.reasoning ?? current.configuration.reasoning,
        systemPrompt: latest.configuration?.systemPrompt ?? current.configuration.systemPrompt,
        enabled: true,
        expectedRevision: latest.stateRevision,
      });
      return waitForAssistantSession(async () =>
        (await selectedSourceApi.stewardConfigurationGet(assistantProjectId)).configuration?.executorSessionId ?? null);
    },
    restartWorker: async (workerId: string): Promise<string | null> => {
      const before = await selectedSourceApi.workerConfigurationList({ projectId: assistantProjectId });
      const worker = before.configurations.find((candidate) => candidate.id === workerId);
      if (!worker?.enabled) return null;
      if (worker.executorSessionId) await selectedSourceApi.sessionTerminate(worker.executorSessionId);
      const latest = await selectedSourceApi.workerConfigurationList({ projectId: assistantProjectId });
      const current = latest.configurations.find((candidate) => candidate.id === workerId) ?? worker;
      await selectedSourceApi.workerConfigurationUpdate({
        workerId,
        name: current.name,
        agentId: current.agentId,
        model: current.model,
        permission: current.permission,
        reasoning: current.reasoning,
        enabled: true,
        pingIntervalSeconds: current.pingIntervalSeconds,
        workerPrompt: current.workerPrompt,
        systemPrompt: current.systemPrompt,
        expectedRevision: latest.stateRevision,
      });
      return waitForAssistantSession(async () => {
        const result = await selectedSourceApi.workerConfigurationList({ projectId: assistantProjectId });
        return result.configurations.find((candidate) => candidate.id === workerId)?.executorSessionId ?? null;
      });
    },
  };

  const promptSettings = useMemo(
    () => createPromptSettingsActions(assistantProjectId, selectedSourceApi),
    [assistantProjectId, selectedSourceApi],
  );
  const skillProjectId = selectedProject
    ? (connectionEntityIdentity(selectedProject.id)?.entityId ?? selectedProject.id)
    : null;
  const loadSkillCatalog = useCallback(
    () => selectedSourceApi.skillCatalogGet({ projectId: skillProjectId }),
    [selectedSourceApi, skillProjectId],
  );
  const loadSkillDefinition = useCallback(
    (skillId: string) => selectedSourceApi.skillDefinitionGet({ projectId: skillProjectId, skillId }),
    [selectedSourceApi, skillProjectId],
  );
  const saveSkillDefinition = useCallback(
    (skillId: string, expectedContentSha256: string, content: string) => selectedSourceApi.skillDefinitionSave({
      projectId: skillProjectId,
      skillId,
      expectedContentSha256,
      content,
    }),
    [selectedSourceApi, skillProjectId],
  );
  const setSkillDeployment = useCallback(
    (skillId: string, agent: "claude" | "codex", deployed: boolean) => selectedSourceApi.skillDeploymentSet({
      projectId: skillProjectId,
      skillId,
      agent,
      deployed,
    }),
    [selectedSourceApi, skillProjectId],
  );
  const loadContextBankCatalog = useCallback(() => {
    if (!skillProjectId) return Promise.reject(new Error("Open a Project to view its Context Bank."));
    return selectedSourceApi.contextBankCatalogGet({ projectId: skillProjectId });
  }, [selectedSourceApi, skillProjectId]);
  const loadContextBankFile = useCallback((fileId: string) => {
    if (!skillProjectId) return Promise.reject(new Error("The Context Bank Project is no longer selected."));
    return selectedSourceApi.contextBankFileGet({ projectId: skillProjectId, fileId });
  }, [selectedSourceApi, skillProjectId]);
  const saveContextBankFile = useCallback((fileId: string, expectedContentSha256: string, content: string) => {
    if (!skillProjectId) return Promise.reject(new Error("The Context Bank Project is no longer selected."));
    return selectedSourceApi.contextBankFileSave({
      projectId: skillProjectId,
      fileId,
      expectedContentSha256,
      content,
    });
  }, [selectedSourceApi, skillProjectId]);
  const resolveContextBankSiblingConflict = useCallback((conflictId: string, sourceFileId: string) => {
    if (!skillProjectId) return Promise.reject(new Error("The Context Bank Project is no longer selected."));
    return selectedSourceApi.contextBankSiblingConflictResolve({
      projectId: skillProjectId,
      conflictId,
      sourceFileId,
    });
  }, [selectedSourceApi, skillProjectId]);

  return (<>
    <Shell
      projects={projection.projects}
      projectTasks={projection.tasks}
      gitHostProjections={projection.gitHostProjections}
      branchCommitSummaries={projection.branchCommitSummaries}
      runConfigurations={projection.runConfigurations}
      runRuntimes={projection.runRuntimes}
      runStateRevision={projection.runStateRevision}
      playbookRuntime={projection.playbookRuntime}
      projectSessions={projectSessions}
      projectWorktreeSummary={projection.projectWorktreeSummary}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      layout={projectLayout}
      visibleSessionIds={visibleSessionIds}
      reviewReadySessionIds={presentation.reviewReadySessionIds}
      deletingTaskIds={deletingTaskIds}
      agentStatuses={presentedAgentStatuses}
      agentCapabilities={agentCapabilities}
      connection={projection.connection}
      connectionMessage={projection.message}
      isPackaged={isPackaged}
      errorLog={projection.errorLog}
      clearErrorLog={() => projectionStore.clearErrorLog()}
      prepareMobileAccess={desktopApi.mobileAccessPairing}
      listConnectionProfiles={desktopApi.connectionProfileList}
      connectConnectionProfile={async (input) => {
        const result = await desktopApi.connectionProfileConnect(input);
        await refreshProjection();
        return result;
      }}
      setConnectionProfileEnabled={async (profileId, enabled) => {
        const profiles = await desktopApi.connectionProfileSetEnabled(profileId, enabled);
        await refreshProjection();
        return profiles;
      }}
      removeConnectionProfile={async (profileId) => {
        const profiles = await desktopApi.connectionProfileRemove(profileId);
        await refreshProjection();
        return profiles;
      }}
      subscribeConnectionStatus={onConnectionStatus}
      discoverTailscaleServers={desktopApi.tailscaleServerDiscover}
      remoteHostStatus={desktopApi.remoteHostStatus}
      enableRemoteHost={desktopApi.remoteHostEnable}
      disableRemoteHost={desktopApi.remoteHostDisable}
      loadMcpToolSettings={selectedSourceApi.mcpToolSettingsGet}
      updateMcpToolDescription={selectedSourceApi.mcpToolDescriptionUpdate}
      resetMcpToolDescription={selectedSourceApi.mcpToolDescriptionReset}
      loadPromptAssets={promptSettings.load}
      updatePromptAsset={promptSettings.update}
      resetPromptAsset={promptSettings.reset}
      loadSkillCatalog={loadSkillCatalog}
      setSkillDeployment={setSkillDeployment}
      loadSkillDefinition={loadSkillDefinition}
      saveSkillDefinition={saveSkillDefinition}
      loadContextBankCatalog={loadContextBankCatalog}
      loadContextBankFile={loadContextBankFile}
      saveContextBankFile={saveContextBankFile}
      resolveContextBankSiblingConflict={resolveContextBankSiblingConflict}
      loadKeepAwake={selectedSourceApi.keepAwakeGet}
      setKeepAwake={selectedSourceApi.keepAwakeSet}
      keepAwakeRefreshToken={keepAwakeRefreshToken}
      assistantActions={assistantActions}
      assistantRefreshToken={assistantRefreshToken}
      taskSourceActions={taskSourceActions}
      taskSourceRefreshToken={taskSourceRefreshToken}
      projectDialogOpen={presentation.projectDialogOpen}
      selectProject={selectProject}
      selectSession={selectSession}
      navigateSession={navigateSession}
      openProjectDialog={presentation.openProjectDialog}
      closeProjectDialog={presentation.closeProjectDialog}
      defaultProjectsRoot={(profileId) => desktopApi.source(profileId).defaultProjectsRoot()}
      browseDirectory={(profileId, folderPath) => desktopApi.source(profileId).browseDirectory(folderPath)}
      pickLocalFolder={(defaultPath) => desktopApi.pickLocalFolder(defaultPath)}
      createProject={createProject}
      updateProject={updateProject}
      deleteProject={deleteProject}
      createTask={createTask}
      updateTask={updateTask}
      bindTaskBranch={bindTaskBranch}
      listProjectLocalBranches={listProjectLocalBranches}
      provisionTaskWorktree={provisionTaskWorktree}
      dismissTaskWorktreeProvisioning={dismissTaskWorktreeProvisioning}
      inspectTaskWorktreeCleanup={inspectTaskWorktreeCleanup}
      cleanupTaskWorktree={cleanupTaskWorktree}
      listProjectWorktreeChanges={(projectId) => sourceApiForProject(projectId).projectWorktreeChangeList(projectId)}
      getProjectWorktreeDiff={(projectId, observationId, entryId) => sourceApiForProject(projectId).projectWorktreeDiff(projectId, observationId, entryId)}
      getProjectWorktreePreImage={(projectId, observationId, entryId) => sourceApiForProject(projectId).projectWorktreePreImage(projectId, observationId, entryId)}
      listTaskWorktreeChanges={(taskId) => sourceApiForTask(taskId).taskWorktreeChangeList(taskId)}
      getTaskWorktreeDiff={(taskId, observationId, entryId) => sourceApiForTask(taskId).taskWorktreeDiff(taskId, observationId, entryId)}
      getTaskWorktreePreImage={(taskId, observationId, entryId) => sourceApiForTask(taskId).taskWorktreePreImage(taskId, observationId, entryId)}
      listTaskBranchCommits={(taskId) => sourceApiForTask(taskId).taskBranchCommitList(taskId)}
      listTaskBranchCommitChanges={(taskId, observationId, commitId) => sourceApiForTask(taskId).taskBranchCommitChangeList(taskId, observationId, commitId)}
      getTaskBranchCommitDiff={(taskId, observationId, commitId, entryId) => sourceApiForTask(taskId).taskBranchCommitDiff(taskId, observationId, commitId, entryId)}
      listTaskPullRequestChanges={(taskId, expectedFreshnessGeneration, pullRequest) => sourceApiForTask(taskId).gitHostPullRequestChangeList(taskId, expectedFreshnessGeneration, pullRequest)}
      getTaskPullRequestDiff={(taskId, observationId, entryId) => sourceApiForTask(taskId).gitHostPullRequestDiff(taskId, observationId, entryId)}
      sendTaskReviewNotes={sendTaskReviewNotes}
      sendProjectReviewNotes={sendProjectReviewNotes}
      setTaskClosed={setTaskClosed}
      listArchivedTasks={listArchivedTasks}
      inspectTaskArchive={inspectTaskArchive}
      archiveTask={archiveTask}
      restoreTask={restoreTask}
      listArchivedSessions={listArchivedSessions}
      listDeletedSessions={listDeletedSessions}
      archiveSession={archiveSession}
      restoreArchivedSession={restoreArchivedSession}
      deleteArchivedSession={deleteArchivedSession}
      restoreDeletedSession={restoreDeletedSession}
      deleteTaskAndWorktree={deleteTaskAndWorktree}
      deleteArchivedTaskAndWorktree={deleteArchivedTaskAndWorktree}
      openExternal={openExternal}
      copySessionId={(sessionId) => sourceApiForSession(sessionId).copySessionId(sessionId)}
      launchTerminal={launchTerminal}
      launchAgent={launchAgent}
      loadSessionHistory={loadSessionHistory}
      loadSessionHistoryPreview={loadSessionHistoryPreview}
      resumeHistorySession={resumeHistorySession}
      previewQuickAction={(projectId, agentId, model, permission, reasoning, prompt, attachmentIds) => sourceApiForProject(projectId).quickActionPreview(projectId, agentId, model, permission, reasoning, prompt, attachmentIds)}
      pasteQuickActionImage={(projectId) => sourceApiForProject(projectId).quickActionPasteImage()}
      restoreQuickActionImage={(attachmentId) => {
        const identity = connectionAttachmentIdentity(attachmentId);
        const profileId = identity?.profileId ?? "local";
        if (profileId !== connectionProfileIdOf(selectedProject)) {
          throw new Error("The saved image belongs to another computer. Paste it again for this Project.");
        }
        return sourceApiForAttachmentId(attachmentId).quickActionRestoreImage(attachmentId);
      }}
      discardQuickActionImage={(attachmentId) => sourceApiForAttachmentId(attachmentId).quickActionDiscardImage(attachmentId)}
      launchQuickAction={launchQuickAction}
      launchTaskTerminal={launchTaskTerminal}
      launchTaskAgent={launchTaskAgent}
      runImprovement={runImprovement}
      settingsImprovement={settingsImprovement}
      saveRunConfiguration={saveRunConfiguration}
      deleteRunConfiguration={deleteRunConfiguration}
      launchTaskRun={launchTaskRun}
      launchProjectRun={launchProjectRun}
      inspectTaskWorktreeRepair={inspectTaskWorktreeRepair}
      repairTaskWorktree={repairTaskWorktree}
      dismissTaskWorktreeRepair={async (taskId, operationId) => {
        try {
          const outcome = await sourceApiForTask(taskId).taskDismissWorktreeRepair(taskId, operationId);
          if (!outcome.ok) return taskRepairError(outcome);
          await refreshTaskProjection([taskId]);
          return undefined;
        }
        catch (error) { const message = controlErrorMessage(error); projectionStore.setMessage(message); return message; }
      }}
      renameSession={renameSession}
      forkSession={forkSession}
      repairProviderHistory={repairProviderHistory}
      requestAgentAskTo={requestAgentAskTo}
      requestAgentHandoverTo={requestAgentHandoverTo}
      dismissSession={dismissSession}
      resumeSession={resumeSession}
      restartAgent={restartAgent}
      previewSessionRelocation={(sessionId, taskId, mode) => sourceApiForSession(sessionId).sessionPreviewRelocateAgent(sessionId, taskId, mode)}
      relocateSession={async (sessionId, taskId, operationId, relocationTicket, mode, manifestDigest) => {
        const api = sourceApiForSession(sessionId);
        try {
          const session = await relocateAgentToTaskWithStartupRetry(api, {
            sessionId,
            taskId,
            operationId,
            relocationTicket,
            mode,
            manifestDigest,
          });
          return sessionRequiresProviderHistoryRepair(session);
        } catch (error) {
          projectionStore.setMessage(controlErrorMessage(error));
          throw error;
        }
      }}
      previewSessionProjectRelocation={(sessionId, projectId) => sourceApiForSession(sessionId).sessionPreviewRelocateAgentToProject(sessionId, projectId)}
      relocateSessionToProject={async (sessionId, projectId, operationId, relocationTicket, manifestDigest) => {
        const api = sourceApiForSession(sessionId);
        try {
          const session = await relocateAgentToProjectWithStartupRetry(api, {
            sessionId,
            projectId,
            operationId,
            relocationTicket,
            manifestDigest,
          });
          return sessionRequiresProviderHistoryRepair(session);
        } catch (error) {
          projectionStore.setMessage(controlErrorMessage(error));
          throw error;
        }
      }}
      closeSession={closeSession}
      bindTerminalHost={bindTerminalHost}
      setTerminalOccluded={setShellTerminalOccluded}
      subscribeNativeShellShortcut={ghosttyBridge.onShellShortcut}
      setNativeOverlayOpen={setShellNativeOverlayOpen}
      overlayContainer={nativeOverlayContainer}
      openSessionInSplit={openSessionInSplit}
      openSessionInSplitAtPane={openSessionInSplitAtPane}
      splitActivePane={splitActivePane}
      focusPane={focusPane}
      focusRelativePane={focusRelativePane}
      resizeLayoutSplit={resizeLayoutSplit}
      closePane={closePane}
      clearPane={clearPane}
      terminalResizeOwner={(sessionId) => terminalPool.resizeOwnership(sessionId)}
      reorderSession={reorderSession}
      agentGroups={selectedProject ? presentation.agentGroupsByProject[selectedProject.id] ?? [] : []}
      detachedRelationshipSessionIds={detachedRelationshipSessionIds}
      groupAgentSessions={groupAgentSessions}
      renameAgentGroup={renameAgentGroup}
      ungroupAgentGroup={ungroupAgentGroup}
      detachAgentRelationship={detachAgentRelationship}
    />
    <OverlayPortal container={nativeOverlayContainer}>
      {launchInspection ? <AgentLaunchInspector {...launchInspection} close={() => setLaunchInspection(undefined)} /> : null}
    </OverlayPortal>
  </>);
}

function taskRepairError(failure: { message: string; details: ProtocolErrorDetails | undefined }): string {
  if (failure.details?.kind === "worktreeRepairRefused") {
    return `Worktree repair refused: ${failure.details.blockers.join(", ")}.`;
  }
  if (failure.details?.kind === "worktreeRepairRecoveryAttention") {
    return `Worktree repair needs recovery attention (${failure.details.operationId}).`;
  }
  if (failure.details?.kind === "repairInProgress") {
    return `Worktree repair is already in progress (${failure.details.operationId}).`;
  }
  if (failure.details?.kind === "managedWorktreeProofChanged") {
    return "The managed worktree changed; inspect it again before repairing.";
  }
  return failure.message;
}

function focusTerminalSoon(sessionId: string): void {
  requestAnimationFrame(() => requestAnimationFrame(() => terminalPool.focus(sessionId)));
}

function afterTwoFrames(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
