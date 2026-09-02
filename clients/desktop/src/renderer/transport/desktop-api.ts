import type { AgentStatus, Project, Session, Task } from "../model.js";
import type { MobileAccessPairingResult } from "../mobile-access.js";
import type { PromptAsset } from "../prompt-settings.js";
import type { QuickActionImageHandle } from "../../quick-action-image.js";
import type { LayoutDocument } from "../../layout/model.js";
import type {
  ConnectionProfileConnectInput,
  ConnectionProfileConnectResult,
  ConnectionProfileSummary,
  RemoteHostStatus,
  RemoteHostTransport,
  TailscaleServerDiscovery,
} from "../../connection-profile-types.js";
import type {
  ErrorCode,
  ProjectTaskAutomationGetResult,
  ProjectTaskAutomationSetParams,
  ProjectTaskAutomationSetResult,
  TaskSourceCandidateImportParams,
  TaskSourceListParams,
  TaskSourceListResult,
  TaskSourceBoardListParams,
  TaskSourceBoardListResult,
  TaskSourceStoredBoardListParams,
  TaskSourceStatusListParams,
  TaskSourceStatusListResult,
  TaskSourceStoredStatusListParams,
  TaskSourceCreateParams,
  TaskSourceUpdateParams,
  TaskSourceMutationResult,
  TaskSourceCredentialsSetParams,
  TaskSourceCredentialsSetResult,
  TaskSourceDeleteParams,
  TaskSourceDeleteResult,
  TaskSourceRefreshParams,
  TaskSourceRefreshResult,
  TaskSourceCandidateListParams,
  TaskSourceCandidateListResult,
  TaskSourceCandidateMutationParams,
  TaskSourceCandidateMutationResult,
  TaskSourceCandidateImportResult,
  DirectoryBrowseResult,
  DeletedSessionDto,
  SessionHistoryPreviewResult,
  DefaultProjectsRootResult,
  ProtocolErrorDetails,
  TaskProvisionWorktreeParams,
  TaskProvisionWorktreeResult,
  TaskCleanupWorktreeParams,
  TaskCleanupWorktreeResult,
  TaskForgetStaleWorktreeParams,
  TaskDiscardStaleWorktreeParams,
  TaskWorktreeCleanupPreviewDto,
  AgentCapabilityDto,
  AgentCoordinationDeliveryResult,
  CompanionProposalRespondParams,
  CompanionProposalRespondResult,
  CompanionSuggestionAcceptParams,
  CompanionSuggestionAcceptResult,
  CompanionTranscriptAppendParams,
  CompanionTranscriptAppendResult,
  CompanionTranscriptClearParams,
  CompanionTranscriptClearResult,
  CompanionTranscriptListParams,
  CompanionTranscriptListResult,
  StewardConfigurationGetResult,
  StewardConfigurationDeleteParams,
  StewardConfigurationDeleteResult,
  StewardConfigurationSetParams,
  StewardConfigurationSetResult,
  WorkerConfigurationCreateParams,
  WorkerConfigurationDeleteParams,
  WorkerConfigurationDeleteResult,
  WorkerConfigurationListParams,
  WorkerConfigurationListResult,
  WorkerConfigurationMutationResult,
  WorkerConfigurationUpdateParams,
  RunConfigurationCreateParams,
  RunConfigurationDeleteParams,
  RunConfigurationDeleteResult,
  RunConfigurationListParams,
  SettingsImprovePreviewParams,
  SettingsImprovePreviewResult,
  SettingsImproveLaunchParams,
  SettingsImproveLaunchResult,
  AssistantPromptImprovePreviewParams,
  AssistantPromptImprovePreviewResult,
  AssistantPromptImproveLaunchParams,
  AssistantPromptImproveLaunchResult,
  RunConfigurationImprovePreviewParams,
  RunConfigurationImprovePreviewResult,
  RunConfigurationImproveLaunchParams,
  RunConfigurationImproveLaunchResult,
  ConfigurationVersionListParams,
  ConfigurationVersionListResult,
  ConfigurationVersionRestoreParams,
  ConfigurationVersionRestoreResult,
  RunConfigurationListResult,
  RunConfigurationMutationResult,
  RunConfigurationUpdateParams,
  RunRuntimeListParams,
  RunRuntimeListResult,
  ProjectRestartRunParams,
  ProjectStartRunParams,
  TaskStartRunParams,
  TaskRestartRunParams,
  RoutineConfigurationCreateParams,
  RoutineConfigurationDeleteParams,
  RoutineConfigurationDeleteResult,
  RoutineConfigurationListParams,
  RoutineConfigurationListResult,
  RoutineConfigurationMutationResult,
  RoutineConfigurationUpdateParams,
  RoutineContextUpdateParams,
  RoutineRuntimeListParams,
  RoutineRuntimeListResult,
  RoutineRunNowParams,
  RoutineRunNowResult,
  PlaybookGetResult,
  PlaybookRuntimeResult,
  PlaybookTaskPositionSetParams,
  PlaybookTaskPositionSetResult,
  PlaybookUpdateParams,
  PlaybookUpdateResult,
  TaskWorktreeRepairPreviewDto,
  TaskRepairWorktreeParams,
  TaskRepairWorktreeResult,
  GitHostTaskProjectionDto,
  GitHostPullRequestIdentityDto,
  GitHostPullRequestChangeListResult,
  GitHostPullRequestDiffResult,
  ProjectLocalBranchListResult,
  ProjectWorktreeChangeListResult,
  ProjectWorktreeDiffResult,
  ProjectWorktreePreImageResult,
  ProjectWorktreeSummaryDto,
  TaskWorktreeChangeListResult,
  TaskWorktreeDiffResult,
  TaskWorktreePreImageResult,
  TaskBranchCommitSummaryDto,
  TaskBranchCommitListResult,
  TaskBranchCommitChangeListResult,
  TaskBranchCommitDiffResult,
  QuickActionPreviewResult,
  AgentLaunchPreviewResult,
  McpToolDescriptionResetParams,
  KeepAwakeSetParams,
  KeepAwakeStatusResult,
  VoiceCredentialsSetParams,
  VoiceSettingsResult,
  McpToolDescriptionUpdateParams,
  McpToolSettingsResult,
  TaskArchivePreviewDto,
  TaskArchiveResultDto,
  TaskArchiveAbandonResultDto,
  TaskRestoreResultDto,
  TaskArchivedContextDto,
  TaskUpdateDeveloperNotesParams,
  SessionArchivePreviewDto,
  SessionRelocationPreviewDto,
  SessionRepairProviderHistoryResult,
  SessionHistoryListResult,
  ContextBankCatalogGetParams,
  ContextBankCatalogResult,
  ContextBankFileDto,
  ContextBankFileGetParams,
  ContextBankFileSaveParams,
  ContextBankSiblingConflictResolveParams,
  SkillCatalogGetParams,
  SkillCatalogResult,
  SkillDefinitionDto,
  SkillDefinitionCreateParams,
  SkillDefinitionGetParams,
  SkillDefinitionSaveParams,
  SkillDeploymentSetParams,
} from "@termloop/contract/current";
import {
  PROFILED_DESKTOP_OPERATIONS,
  type ProfiledDesktopOperationName,
} from "../../source-operations.js";

export type TaskBindBranchResult =
  | { ok: true; task: Task }
  | { ok: false; code: ErrorCode | undefined; details: ProtocolErrorDetails | undefined; message: string };

export type TaskProvisionWorktreeDesktopResult =
  | { ok: true; result: TaskProvisionWorktreeResult }
  | { ok: false; code: ErrorCode | undefined; details: ProtocolErrorDetails | undefined; message: string };

export type TaskControlDesktopResult<T> =
  | { ok: true; result: T }
  | { ok: false; code: ErrorCode | undefined; details: ProtocolErrorDetails | undefined; message: string };

import type { ProjectDeleteResult } from "@termloop/contract/current";

export type ProjectDeleteCallResult =
  | { ok: true; result: ProjectDeleteResult }
  | { ok: false; error: { message: string; code?: string; details?: { blocker: "worktrees" } } };

export type DesktopApi = {
  isPackaged(): Promise<boolean>;
  pickLocalFolder(defaultPath?: string): Promise<string | null>;
  mobileAccessPairing(): Promise<MobileAccessPairingResult>;
  connectionProfileList(): Promise<ConnectionProfileSummary[]>;
  connectionProfileReconnect(profileId: string): Promise<ConnectionProfileSummary[]>;
  connectionProfileConnect(input: ConnectionProfileConnectInput): Promise<ConnectionProfileConnectResult>;
  connectionProfileSetEnabled(profileId: string, enabled: boolean): Promise<ConnectionProfileSummary[]>;
  connectionProfileRemove(profileId: string): Promise<ConnectionProfileSummary[]>;
  tailscaleServerDiscover(): Promise<TailscaleServerDiscovery>;
  remoteHostStatus(): Promise<RemoteHostStatus>;
  remoteHostEnable(transport: RemoteHostTransport): Promise<RemoteHostStatus>;
  remoteHostDisable(): Promise<RemoteHostStatus>;
  terminalRendererKind(): Promise<"xterm" | "ghostty">;
  nativeOverlaySetVisible(visible: boolean): Promise<void>;
  nativeOverlaySetPassiveVisible(visible: boolean): Promise<void>;
  nativeOverlaySetPointerInteractive(interactive: boolean): Promise<void>;
  nativeOverlaySetPassiveRegion(region: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  ghosttySurfaceCreate(frame?: { x: number; y: number; width: number; height: number }): Promise<{ surfaceId: number; rows: number; cols: number }>;
  ghosttySurfaceWrite(surfaceId: number, data: ArrayBuffer): Promise<void>;
  ghosttySurfaceSetFrame(surfaceId: number, x: number, y: number, width: number, height: number): Promise<{ rows: number; cols: number } | undefined>;
  ghosttySurfaceSetVisible(surfaceId: number, visible: boolean): Promise<void>;
  ghosttySurfaceSnapshotText(surfaceId: number): Promise<string | undefined>;
  ghosttySurfaceSnapshotImage(surfaceId: number): Promise<string | undefined>;
  ghosttySurfaceSnapshotAndHide(surfaceId: number): Promise<string | undefined>;
  ghosttySurfaceFocus(surfaceId: number): Promise<void>;
  ghosttySurfaceDiagnosticText(surfaceId: number): Promise<string | undefined>;
  ghosttySurfaceDestroy(surfaceId: number): Promise<void>;
  systemInfo(): Promise<Record<string, unknown>>;
  keepAwakeGet(): Promise<KeepAwakeStatusResult>;
  keepAwakeSet(params: KeepAwakeSetParams): Promise<KeepAwakeStatusResult>;
  voiceSettingsGet(): Promise<VoiceSettingsResult>;
  voiceCredentialsSet(params: VoiceCredentialsSetParams): Promise<VoiceSettingsResult>;
  mcpToolSettingsGet(): Promise<McpToolSettingsResult>;
  mcpToolDescriptionUpdate(params: McpToolDescriptionUpdateParams): Promise<TaskControlDesktopResult<McpToolSettingsResult>>;
  mcpToolDescriptionReset(params: McpToolDescriptionResetParams): Promise<TaskControlDesktopResult<McpToolSettingsResult>>;
  promptAssetsGet(): Promise<PromptAsset[]>;
  promptAssetUpdate(id: string, body: string): Promise<PromptAsset[]>;
  promptAssetReset(id: string): Promise<PromptAsset[]>;
  skillCatalogGet(params: SkillCatalogGetParams): Promise<SkillCatalogResult>;
  skillDeploymentSet(params: SkillDeploymentSetParams): Promise<SkillCatalogResult>;
  skillDefinitionGet(params: SkillDefinitionGetParams): Promise<SkillDefinitionDto>;
  skillDefinitionSave(params: SkillDefinitionSaveParams): Promise<SkillDefinitionDto>;
  skillDefinitionCreate(params: SkillDefinitionCreateParams): Promise<SkillCatalogResult>;
  contextBankCatalogGet(params: ContextBankCatalogGetParams): Promise<ContextBankCatalogResult>;
  contextBankFileGet(params: ContextBankFileGetParams): Promise<ContextBankFileDto>;
  contextBankFileSave(params: ContextBankFileSaveParams): Promise<ContextBankFileDto>;
  contextBankSiblingConflictResolve(params: ContextBankSiblingConflictResolveParams): Promise<ContextBankCatalogResult>;
  projectList(): Promise<Project[]>;
  projectWorktreeSummary(projectId: string): Promise<ProjectWorktreeSummaryDto>;
  projectWorktreeChangeList(projectId: string): Promise<ProjectWorktreeChangeListResult>;
  projectWorktreeDiff(projectId: string, observationId: string, entryId: string): Promise<ProjectWorktreeDiffResult>;
  projectWorktreePreImage(projectId: string, observationId: string, entryId: string): Promise<ProjectWorktreePreImageResult>;
  projectCreate(name: string, folderPath: string): Promise<Project>;
  projectUpdate(projectId: string, name: string, folderPath: string): Promise<Project>;
  projectDelete(projectId: string): Promise<ProjectDeleteCallResult>;
  projectListLocalBranches(projectId: string): Promise<ProjectLocalBranchListResult>;
  projectTaskAutomationGet(projectId: string): Promise<ProjectTaskAutomationGetResult>;
  projectTaskAutomationSet(params: ProjectTaskAutomationSetParams): Promise<ProjectTaskAutomationSetResult>;
  taskList(
    projectId: string,
    taskIds?: string[],
    archiveScope?: "active" | "archived" | "all",
  ): Promise<Task[]>;
  taskWorktreeChangeList(taskId: string): Promise<TaskWorktreeChangeListResult>;
  taskWorktreeDiff(taskId: string, observationId: string, entryId: string): Promise<TaskWorktreeDiffResult>;
  taskWorktreePreImage(taskId: string, observationId: string, entryId: string): Promise<TaskWorktreePreImageResult>;
  taskBranchCommitSummaryList(projectId: string, taskIds: string[]): Promise<TaskBranchCommitSummaryDto[]>;
  taskBranchCommitList(taskId: string, branchId?: string): Promise<TaskBranchCommitListResult>;
  taskBranchCommitChangeList(taskId: string, observationId: string, commitId: string): Promise<TaskBranchCommitChangeListResult>;
  taskBranchCommitDiff(taskId: string, observationId: string, commitId: string, entryId: string): Promise<TaskBranchCommitDiffResult>;
  gitHostPullRequestList(projectId: string, taskIds: string[]): Promise<GitHostTaskProjectionDto[]>;
  gitHostPullRequestChangeList(taskId: string, expectedFreshnessGeneration: number, pullRequest: GitHostPullRequestIdentityDto): Promise<GitHostPullRequestChangeListResult>;
  gitHostPullRequestDiff(taskId: string, observationId: string, entryId: string): Promise<GitHostPullRequestDiffResult>;
  openExternal(url: string, runSessionId?: string): Promise<void>;
  copySessionId(sessionId: string): Promise<void>;
  taskInspectWorktreeCleanup(taskId: string): Promise<TaskWorktreeCleanupPreviewDto>;
  taskCleanupWorktree(params: TaskCleanupWorktreeParams): Promise<TaskCleanupWorktreeResult>;
  taskForgetStaleWorktree(params: TaskForgetStaleWorktreeParams): Promise<TaskControlDesktopResult<Task>>;
  taskDiscardStaleWorktree(params: TaskDiscardStaleWorktreeParams): Promise<TaskControlDesktopResult<Task>>;
  taskInspectWorktreeRepair(taskId: string, candidatePath: string): Promise<TaskControlDesktopResult<TaskWorktreeRepairPreviewDto>>;
  taskRepairWorktree(params: TaskRepairWorktreeParams): Promise<TaskControlDesktopResult<TaskRepairWorktreeResult>>;
  taskDismissWorktreeRepair(taskId: string, operationId: string): Promise<TaskControlDesktopResult<Task>>;
  taskBindBranch(taskId: string, repositoryPath: string, branchName: string): Promise<TaskBindBranchResult>;
  taskProvisionWorktree(params: TaskProvisionWorktreeParams): Promise<TaskProvisionWorktreeDesktopResult>;
  taskDismissWorktreeProvisioning(taskId: string, operationId: string): Promise<Task>;
  taskCreate(projectId: string, title: string, brief: string | null): Promise<Task>;
  taskRename(taskId: string, title: string): Promise<Task>;
  taskUpdateBrief(taskId: string, brief: string | null): Promise<Task>;
  taskUpdateDeveloperNotes(params: TaskUpdateDeveloperNotesParams): Promise<Task>;
  taskClose(taskId: string): Promise<Task>;
  taskFinalizeClosedWorktreeRemoval(taskId: string): Promise<Task>;
  taskInspectArchive(taskId: string): Promise<TaskArchivePreviewDto>;
  taskArchive(taskId: string, archiveTicket: string): Promise<TaskArchiveResultDto>;
  taskAbandonArchive(taskId: string, operationId: string): Promise<TaskArchiveAbandonResultDto>;
  taskRestore(taskId: string): Promise<TaskRestoreResultDto>;
  taskArchivedContext(taskId: string): Promise<TaskArchivedContextDto>;
  taskReopen(taskId: string): Promise<Task>;
  taskDelete(taskId: string): Promise<{ deleted: boolean }>;
  taskDeleteArchived(taskId: string): Promise<{ deleted: boolean }>;
  defaultProjectsRoot(): Promise<DefaultProjectsRootResult>;
  browseDirectory(folderPath: string): Promise<DirectoryBrowseResult>;
  layoutLoad(): Promise<LayoutDocument>;
  layoutSave(document: LayoutDocument): Promise<void>;
  sessionList(): Promise<Session[]>;
  sessionListArchived(projectId: string): Promise<Session[]>;
  sessionListDeleted(projectId: string): Promise<DeletedSessionDto[]>;
  sessionInspectArchive(sessionId: string): Promise<SessionArchivePreviewDto>;
  sessionArchive(sessionId: string, archiveTicket: string): Promise<Session>;
  sessionRestoreArchived(sessionId: string): Promise<Session>;
  sessionDeleteArchived(sessionId: string): Promise<{ sessionId: string; closed: boolean }>;
  sessionRestoreDeleted(sessionId: string): Promise<Session>;
  agentStatusList(): Promise<AgentStatus[]>;
  agentCapabilityList(): Promise<AgentCapabilityDto[]>;
  stewardConfigurationGet(projectId: string): Promise<StewardConfigurationGetResult>;
  stewardConfigurationSet(params: StewardConfigurationSetParams): Promise<StewardConfigurationSetResult>;
  stewardConfigurationDelete(params: StewardConfigurationDeleteParams): Promise<StewardConfigurationDeleteResult>;
  workerConfigurationList(params: WorkerConfigurationListParams): Promise<WorkerConfigurationListResult>;
  workerConfigurationCreate(params: WorkerConfigurationCreateParams): Promise<WorkerConfigurationMutationResult>;
  workerConfigurationUpdate(params: WorkerConfigurationUpdateParams): Promise<WorkerConfigurationMutationResult>;
  workerConfigurationDelete(params: WorkerConfigurationDeleteParams): Promise<WorkerConfigurationDeleteResult>;
  runConfigurationList(params: RunConfigurationListParams): Promise<RunConfigurationListResult>;
  runConfigurationCreate(params: RunConfigurationCreateParams): Promise<RunConfigurationMutationResult>;
  runConfigurationUpdate(params: RunConfigurationUpdateParams): Promise<RunConfigurationMutationResult>;
  runConfigurationDelete(params: RunConfigurationDeleteParams): Promise<RunConfigurationDeleteResult>;
  runConfigurationImprovePreview(params: RunConfigurationImprovePreviewParams): Promise<RunConfigurationImprovePreviewResult>;
  runConfigurationImproveLaunch(params: RunConfigurationImproveLaunchParams): Promise<RunConfigurationImproveLaunchResult>;
  settingsImprovePreview(params: SettingsImprovePreviewParams): Promise<SettingsImprovePreviewResult>;
  settingsImproveLaunch(params: SettingsImproveLaunchParams): Promise<SettingsImproveLaunchResult>;
  assistantPromptImprovePreview(params: AssistantPromptImprovePreviewParams): Promise<AssistantPromptImprovePreviewResult>;
  assistantPromptImproveLaunch(params: AssistantPromptImproveLaunchParams): Promise<AssistantPromptImproveLaunchResult>;
  configurationVersionList(params: ConfigurationVersionListParams): Promise<ConfigurationVersionListResult>;
  configurationVersionRestore(params: ConfigurationVersionRestoreParams): Promise<ConfigurationVersionRestoreResult>;
  runRuntimeList(params: RunRuntimeListParams): Promise<RunRuntimeListResult>;
  routineConfigurationList(params: RoutineConfigurationListParams): Promise<RoutineConfigurationListResult>;
  routineConfigurationCreate(params: RoutineConfigurationCreateParams): Promise<RoutineConfigurationMutationResult>;
  routineConfigurationUpdate(params: RoutineConfigurationUpdateParams): Promise<RoutineConfigurationMutationResult>;
  routineContextUpdate(params: RoutineContextUpdateParams): Promise<RoutineConfigurationMutationResult>;
  routineConfigurationDelete(params: RoutineConfigurationDeleteParams): Promise<RoutineConfigurationDeleteResult>;
  routineRuntimeList(params: RoutineRuntimeListParams): Promise<RoutineRuntimeListResult>;
  routineRunNow(params: RoutineRunNowParams): Promise<RoutineRunNowResult>;
  taskSourceList(params: TaskSourceListParams): Promise<TaskSourceListResult>;
  taskSourceBoardList(params: TaskSourceBoardListParams): Promise<TaskSourceBoardListResult>;
  taskSourceBoardListStored(params: TaskSourceStoredBoardListParams): Promise<TaskSourceBoardListResult>;
  taskSourceStatusList(params: TaskSourceStatusListParams): Promise<TaskSourceStatusListResult>;
  taskSourceStatusListStored(params: TaskSourceStoredStatusListParams): Promise<TaskSourceStatusListResult>;
  taskSourceCreate(params: TaskSourceCreateParams): Promise<TaskSourceMutationResult>;
  taskSourceUpdate(params: TaskSourceUpdateParams): Promise<TaskSourceMutationResult>;
  taskSourceConnect(params: TaskSourceCredentialsSetParams): Promise<TaskSourceCredentialsSetResult>;
  taskSourceDelete(params: TaskSourceDeleteParams): Promise<TaskSourceDeleteResult>;
  taskSourceRefresh(params: TaskSourceRefreshParams): Promise<TaskSourceRefreshResult>;
  taskSourceCandidateList(params: TaskSourceCandidateListParams): Promise<TaskSourceCandidateListResult>;
  taskSourceCandidateImport(params: TaskSourceCandidateImportParams): Promise<TaskSourceCandidateImportResult>;
  taskSourceCandidateIgnore(params: TaskSourceCandidateMutationParams): Promise<TaskSourceCandidateMutationResult>;
  taskSourceCandidateUnignore(params: TaskSourceCandidateMutationParams): Promise<TaskSourceCandidateMutationResult>;
  playbookGet(projectId: string): Promise<PlaybookGetResult>;
  playbookRuntime(projectId: string): Promise<PlaybookRuntimeResult>;
  playbookTaskPositionSet(params: PlaybookTaskPositionSetParams): Promise<TaskControlDesktopResult<PlaybookTaskPositionSetResult>>;
  playbookUpdate(params: PlaybookUpdateParams): Promise<TaskControlDesktopResult<PlaybookUpdateResult>>;
  companionTranscriptList(params: CompanionTranscriptListParams): Promise<CompanionTranscriptListResult>;
  companionTranscriptAppend(params: CompanionTranscriptAppendParams): Promise<CompanionTranscriptAppendResult>;
  companionProposalRespond(params: CompanionProposalRespondParams): Promise<CompanionProposalRespondResult>;
  companionSuggestionAccept(params: CompanionSuggestionAcceptParams): Promise<CompanionSuggestionAcceptResult>;
  companionTranscriptClear(params: CompanionTranscriptClearParams): Promise<CompanionTranscriptClearResult>;
  notifyAgentAttention(sessionId: string): Promise<{ accepted: boolean }>;
  sessionRename(sessionId: string, name: string | null): Promise<Session>;
  terminalLaunch(projectId: string): Promise<Session>;
  agentPreview(projectId: string, agentId: string, model?: string, permission?: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning?: "default" | "low" | "medium" | "high" | "xhigh" | "max"): Promise<AgentLaunchPreviewResult>;
  agentLaunch(projectId: string, agentId: string, launchTicket: string): Promise<Session>;
  quickActionPasteImage(): Promise<QuickActionImageHandle>;
  quickActionRestoreImage(attachmentId: string): Promise<QuickActionImageHandle>;
  quickActionDiscardImage(attachmentId: string): Promise<void>;
  quickActionPreview(projectId: string, agentId: string, model: string, permission: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max", prompt: string, attachmentIds: string[]): Promise<QuickActionPreviewResult>;
  quickActionLaunch(projectId: string, agentId: string, model: string, permission: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max", prompt: string, attachmentIds: string[], launchTicket: string): Promise<Session>;
  taskTerminalLaunch(taskId: string): Promise<TaskControlDesktopResult<Session>>;
  taskStartRun(params: TaskStartRunParams): Promise<TaskControlDesktopResult<Session>>;
  taskRestartRun(params: TaskRestartRunParams): Promise<TaskControlDesktopResult<Session>>;
  projectStartRun(params: ProjectStartRunParams): Promise<TaskControlDesktopResult<Session>>;
  projectRestartRun(params: ProjectRestartRunParams): Promise<TaskControlDesktopResult<Session>>;
  taskAgentPreview(taskId: string, agentId: string, model: string, permission: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max", kickoffMessage?: string): Promise<TaskControlDesktopResult<AgentLaunchPreviewResult>>;
  taskAgentLaunch(taskId: string, agentId: string, launchTicket: string): Promise<TaskControlDesktopResult<Session>>;
  sessionTerminate(sessionId: string): Promise<TaskControlDesktopResult<unknown>>;
  sessionPreviewResumeAgent(sessionId: string): Promise<AgentLaunchPreviewResult>;
  sessionResumeAgent(sessionId: string, launchTicket: string): Promise<Session>;
  sessionRestartAgent(sessionId: string): Promise<TaskControlDesktopResult<Session>>;
  sessionPreviewRelocateAgent(sessionId: string, taskId: string, mode: "resume" | "fresh"): Promise<SessionRelocationPreviewDto>;
  sessionRelocateAgent(sessionId: string, taskId: string, operationId: string, relocationTicket: string): Promise<Session>;
  sessionPreviewRelocateAgentToProject(sessionId: string, projectId: string): Promise<SessionRelocationPreviewDto>;
  sessionRelocateAgentToProject(sessionId: string, projectId: string, operationId: string, relocationTicket: string): Promise<Session>;
  sessionForkAgent(sessionId: string): Promise<TaskControlDesktopResult<Session>>;
  sessionRepairProviderHistory(sessionId: string): Promise<TaskControlDesktopResult<SessionRepairProviderHistoryResult>>;
  sessionHistoryList(projectId: string, force?: boolean, fillCache?: boolean): Promise<SessionHistoryListResult>;
  sessionHistoryPreview(projectId: string, sessionId: string): Promise<SessionHistoryPreviewResult>;
  sessionHistoryPreviewResumeAgent(projectId: string, historyHandle: string): Promise<AgentLaunchPreviewResult>;
  sessionHistoryResumeAgent(projectId: string, historyHandle: string, launchTicket: string): Promise<Session>;
  sessionRequestAskTo(sessionId: string, targetAgentId: "claude" | "codex"): Promise<AgentCoordinationDeliveryResult>;
  sessionRequestHandoverTo(sessionId: string, targetSessionId: string): Promise<AgentCoordinationDeliveryResult>;
  sessionPasteImage(sessionId: string): Promise<AgentCoordinationDeliveryResult>;
  sessionClose(sessionId: string): Promise<{ sessionId: string; closed: boolean }>;
  terminalAttach(requestId: string, sessionId: string, runtimeEpoch: number): Promise<{ accepted: true }>;
};

type ProfiledOperationName = ProfiledDesktopOperationName & keyof DesktopApi;
export type SourceDesktopApi = Pick<DesktopApi, ProfiledOperationName>;
type DesktopBridge = Omit<DesktopApi, ProfiledOperationName> & {
  [K in ProfiledOperationName]: DesktopApi[K] extends (...args: infer A) => infer R
    ? (profileId: string, ...args: A) => R
    : never;
};

export type MultiSourceDesktopApi = Omit<DesktopApi, ProfiledOperationName> & {
  source(profileId: string): SourceDesktopApi;
};

declare global {
  interface Window {
    termloop: DesktopBridge;
  }
}

const sourceApis = new Map<string, SourceDesktopApi>();

function sourceApi(profileId: string): SourceDesktopApi {
  let current = sourceApis.get(profileId);
  if (current) return current;
  current = Object.fromEntries(
    Object.keys(PROFILED_DESKTOP_OPERATIONS).map((property) => [
      property,
      (...args: unknown[]) => {
        const operation = window.termloop[property as ProfiledOperationName] as unknown as (
          profileId: string,
          ...parameters: unknown[]
        ) => unknown;
        return operation(profileId, ...args);
      },
    ]),
  ) as SourceDesktopApi;
  sourceApis.set(profileId, current);
  return current;
}

const desktopOperations = new Map<PropertyKey, unknown>();

export const desktopApi = new Proxy({} as MultiSourceDesktopApi, {
  get(_target, property) {
    if (property === "source") return sourceApi;
    if (desktopOperations.has(property)) return desktopOperations.get(property);
    let resolved: unknown;
    if (typeof property === "string" && property in PROFILED_DESKTOP_OPERATIONS) {
      resolved = () => {
        throw new Error(`connectionProfileRequired:${property}`);
      };
    } else {
      const operation = window.termloop[property as keyof DesktopBridge] as unknown;
      resolved = typeof operation === "function"
        ? (...args: unknown[]) => (operation as (...parameters: unknown[]) => unknown)(...args)
        : operation;
    }
    desktopOperations.set(property, resolved);
    return resolved;
  },
});
