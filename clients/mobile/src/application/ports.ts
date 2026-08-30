import type {
  AgentCapabilityDto,
  AgentStatusDto,
  CompanionMessageDto,
  PlaybookDto,
  PlaybookRuntimeResult,
  ProjectDto,
  SessionDto,
  TaskDto,
  TaskWorktreeChangeListResult,
  TaskWorktreeDiffResult,
  TaskWorktreePreImageResult,
} from "@termloop/contract/current";

export type ConnectionAvailability =
  | "online"
  | "reconnecting"
  | "offline"
  | "revoked"
  | "updateRequired";

export interface ConnectionProfile {
  id: string;
  name: string;
  endpointLabel: string;
  availability: ConnectionAvailability;
  lastConnectedAtEpochMs: number | null;
  productVersion: string | null;
  contractIdentity: string | null;
}

export interface MobileOverview {
  projects: readonly ProjectDto[];
  /// Project ids whose authoritative Steward configuration exists and is enabled.
  /// Voice presentation treats absence from this list as unavailable rather than
  /// inferring availability from Project or Session presence.
  stewardEnabledProjectIds: readonly string[];
  /// Exact executor Session ids from the authoritative Steward configurations.
  /// Voice status uses this projection instead of guessing from Session names.
  stewardExecutorSessionIds: Readonly<Record<string, string>>;
  tasks: readonly TaskDto[];
  sessions: readonly SessionDto[];
  agentStatuses: readonly AgentStatusDto[];
}

export interface ConnectionCatalogPort {
  list(): Promise<ConnectionProfile[]>;
  pair(code: string): Promise<string>;
}

export interface ControlReadPort {
  loadOverview(connectionId: string): Promise<MobileOverview>;
}

/// A bounded, read-only snapshot of one Task's local checkout. The observation id
/// binds a diff to the exact list the reviewer saw, so a phone never presents a
/// patch for a file whose worktree entry has since changed underneath it.
export interface WorktreeChangesPort {
  listTask(connectionId: string, taskId: string): Promise<TaskWorktreeChangeListResult>;
  diffTask(
    connectionId: string,
    taskId: string,
    observationId: string,
    entryId: string,
  ): Promise<TaskWorktreeDiffResult>;
  /// The old-side file content bound to the same observation as the patch.
  /// Presentation may reconstruct a full current file from these two bounded
  /// values; it never receives a worktree path or filesystem authority.
  preImageTask(
    connectionId: string,
    taskId: string,
    observationId: string,
    entryId: string,
  ): Promise<TaskWorktreePreImageResult>;
}

/// One Project's delivery pipeline, exactly as the Mac holds it: the pipeline
/// itself, its live per-step standing, and the Routine names the steps are
/// checked by. `playbook` is null for a Project that is not walking one, which
/// the screen states rather than drawing an empty ladder.
export interface PlaybookProjection {
  playbook: PlaybookDto | null;
  runtime: PlaybookRuntimeResult | null;
  routines: readonly { id: string; name: string; enabled: boolean }[];
  stateRevision: number;
}

export interface PlaybookPort {
  read(connectionId: string, projectId: string): Promise<PlaybookProjection>;
  /// Moves one Task to the given rung. `passedMilestoneCount` is the number of
  /// steps behind it, so 0 is "back to the start" and `steps.length` is done.
  setTaskPosition(connectionId: string, params: {
    projectId: string;
    taskId: string;
    passedMilestoneCount: number;
    expectedPlaybookRevision: number;
    expectedRevision: number;
  }): Promise<void>;
  /// Runs one step's completion Routine now instead of waiting for its next
  /// scheduled attempt.
  runRoutineNow(connectionId: string, routineId: string): Promise<void>;
}

export type AgentLaunchAgentId = string;
export type AgentLaunchPermission = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type AgentLaunchReasoning = "default" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentLaunchSelection {
  agentId: AgentLaunchAgentId;
  model: string;
  permission: AgentLaunchPermission;
  reasoning: AgentLaunchReasoning;
}

/// What the Mac says it would actually run, before anything runs. The phone
/// renders this projection of the invocation-owned manifest and never
/// reconstructs launch content of its own.
export interface AgentLaunchInspection {
  launchTicket: string;
  program: string;
  args: readonly string[];
  cwd: string;
  model: string | null;
  permission: string | null;
  reasoning: string | null;
}

export interface AgentLaunchResult {
  sessionId: string;
  runtimeEpoch: number;
  /// `null` means no initial prompt was supplied. `false` means the Session was
  /// started, but the one-shot terminal submission did not complete.
  promptSubmitted: boolean | null;
}

export interface AgentLaunchPort {
  /// Which providers this Mac can actually start right now.
  capabilities(connectionId: string): Promise<readonly AgentCapabilityDto[]>;
  /// Reserves and describes one launch. The ticket is spent by `launch`.
  preview(
    connectionId: string,
    taskId: string,
    selection: AgentLaunchSelection,
  ): Promise<AgentLaunchInspection>;
  /// Starts the exact previewed launch, then submits an optional user-authored
  /// first message through that Session's terminal data plane.
  launch(
    connectionId: string,
    taskId: string,
    selection: Pick<AgentLaunchSelection, "agentId">,
    launchTicket: string,
    prompt?: string,
  ): Promise<AgentLaunchResult>;
  /// Starts an unassigned Project Agent. `folder_path` comes from the Mac's
  /// Project projection; presentation never resolves or inspects it locally.
  previewProject(
    connectionId: string,
    project: Pick<ProjectDto, "id" | "folder_path">,
    selection: AgentLaunchSelection,
  ): Promise<AgentLaunchInspection>;
  launchProject(
    connectionId: string,
    project: Pick<ProjectDto, "id" | "folder_path">,
    selection: Pick<AgentLaunchSelection, "agentId">,
    launchTicket: string,
    prompt?: string,
  ): Promise<AgentLaunchResult>;
}

export type StewardMessage = CompanionMessageDto;

export interface StewardVoiceClip {
  /// Bounded recording bytes read by the platform-owned recorder UI. Keeping
  /// file:// handling out of the transport avoids React Native fetch adapters
  /// re-encoding or partially reading a freshly finalized native recording.
  bytes: ArrayBuffer;
  mediaType: "audio/m4a" | "audio/mp4" | "audio/wav" | "audio/webm";
}

export interface StewardVoiceAppend {
  transcript: string;
  userSequence: number;
}

export interface StewardVoiceReceipt {
  readonly initialized: boolean;
  readonly acknowledgedSequence: number;
  readonly pendingUserSequence: number | null;
}

export interface StewardVoiceReceiptStore {
  read(connectionId: string, projectId: string): Promise<StewardVoiceReceipt>;
  write(connectionId: string, projectId: string, receipt: StewardVoiceReceipt): Promise<void>;
}

export interface StewardPort {
  transcript(connectionId: string, projectId: string): Promise<readonly StewardMessage[]>;
  /// Appends one user message. The daemon's own chat wake brings the Steward up,
  /// exactly as it does for the desktop and Watch chats.
  send(connectionId: string, projectId: string, content: string): Promise<readonly StewardMessage[]>;
  /// Transcribes one bounded recording without appending it. The caller shows
  /// this preview so a recognition mistake can be corrected before delivery.
  transcribeVoice(connectionId: string, clip: StewardVoiceClip): Promise<string>;
  /// Appends the user-confirmed transcript as a voice turn and returns the
  /// sequence that a later Steward reply must follow.
  commitVoice(connectionId: string, projectId: string, transcript: string): Promise<StewardVoiceAppend>;
  /// Returns daemon-generated speech bytes for the exact persisted Steward
  /// message. Provider credentials never cross this port.
  speech(connectionId: string, projectId: string, sequence: number): Promise<Uint8Array>;
  /// Answers one pending Steward proposal or accepts one suggestion.
  respond(connectionId: string, projectId: string, messageId: string, action: "approve" | "decline" | "accept"): Promise<readonly StewardMessage[]>;
}

export type TerminalEvent =
  | { type: "reset" }
  | { type: "replay"; bytes: Uint8Array }
  | { type: "live"; bytes: Uint8Array }
  | { type: "gap"; droppedFrames: number }
  | { type: "eof" }
  | { type: "state"; state: "connecting" | "connected" | "connectionLost" };

export interface TerminalAttachment {
  input(bytes: Uint8Array): Promise<void>;
  /// Replaces the current transport and resolves only after the new socket is
  /// authenticated. Native pickers and foreground transitions can leave iOS
  /// reporting an open WebSocket that no longer carries bytes.
  reconnect(): Promise<void>;
  detach(): Promise<void>;
}

export interface TerminalPort {
  attach(
    connectionId: string,
    session: Pick<SessionDto, "id" | "runtime_epoch">,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalAttachment>;
}

export interface NotificationRegistrationPort {
  registerDevice(connectionId: string, registration: {
    deviceToken: string;
    environment: "development" | "production";
    bundleId: string;
  }): Promise<void>;
}

/// An image selected on the phone. The URI remains device-local; adapters stream
/// its bytes directly to the paired Mac and never retain it in client state.
export interface SelectedImage {
  uri: string;
  mediaType: string | null;
}

export interface SessionImagePort {
  /// Stages one bounded image in the running Session's ignored runtime directory
  /// and returns the path relative to that Session's working directory.
  upload(connectionId: string, sessionId: string, image: SelectedImage): Promise<string>;
}

export interface WatchCompanionPort {
  /// Provisions the paired Apple Watch with one atomic catalog containing every
  /// saved Mac whose watch-scoped credential can currently be refreshed. The
  /// native bridge retains still-saved offline Macs from its previous catalog
  /// and removes Macs that are no longer saved.
  sync(): Promise<boolean>;
  /// The Project that receives new Watch Steward requests for this Mac. It is
  /// client-local preference data, not Project state.
  targetProject(connectionId: string): Promise<string | null>;
  /// Saves the target first, then attempts a latest-state WatchConnectivity
  /// delivery. A false result means the choice is safely queued for next sync.
  setTargetProject(connectionId: string, projectId: string): Promise<{ synced: boolean }>;
}

export interface MobileRuntime {
  readonly kind: "mock" | "production";
  connections: ConnectionCatalogPort;
  control: ControlReadPort;
  worktreeChanges: WorktreeChangesPort;
  playbook: PlaybookPort;
  agentLaunch: AgentLaunchPort;
  steward: StewardPort;
  voiceReceipts: StewardVoiceReceiptStore;
  terminal: TerminalPort;
  images: SessionImagePort;
  notifications: NotificationRegistrationPort;
  watch: WatchCompanionPort;
}
