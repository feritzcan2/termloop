/**
 * TermLoop client — typed request/response envelope and stub methods.
 *
 * Envelope:
 *   request : { id, method, params }
 *   success : { id, ok: true,  result }
 *   error   : { id, ok: false, error: { code: string, message, data? } }
 */

import { connectionHostCandidates } from "./connections";
import { isTerminalSurfaceStartingError } from "./errors";

export type RequestId = string;

export interface RpcRequest<M extends string = string, P = unknown> {
  id: RequestId;
  method: M;
  params?: P;
}

export interface RpcSuccess<R = unknown> {
  id: RequestId;
  ok: true;
  result: R;
}

export interface RpcError {
  id: RequestId;
  ok: false;
  error: { code: string; message: string; data?: unknown };
}

export type RpcResponse<R = unknown> = RpcSuccess<R> | RpcError;

// ---- Domain types --------------------------------------------------------

export interface PingResult {
  pong: true;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path?: string;
  folder_path?: string;
}

export function projectSummaryPath(
  project: ProjectSummary | null | undefined
): string | undefined {
  const path = project?.folder_path?.trim() || project?.path?.trim();
  return path || undefined;
}

export interface WorkspaceSummary {
  id: string;
  /** Backend may send `name` or `title`. Read with `workspaceLabel(ws)`. */
  name?: string;
  title?: string;
  projectId?: string;
  project_id?: string;
  agent?: string;
  branch?: string | null;
  worktree_path?: string | null;
  current_directory?: string | null;
  terminal_agent_id?: string | null;
  permission_mode?: string | null;
  awaiting_input_since?: string | number | null;
  last_message_preview?: string | null;
  last_attention_kind?: string | null;
  agent_activity_phase?: string | null;
  agent_attention_kind?: string | null;
  agent_activity_preview?: string | null;
  agent_activity_updated_at?: number | null;
  git_dirty?: boolean;
  git_change_count?: number;
  pull_requests?: PullRequestSummary[];
}

export function workspaceLabel(ws: WorkspaceSummary): string {
  return (ws.title || ws.name || ws.id || "Workspace").trim() || "Workspace";
}

export function workspaceProjectId(ws: WorkspaceSummary): string | undefined {
  return ws.projectId ?? ws.project_id;
}

export interface SurfaceSummary {
  id: string;
  kind?: string;
  type?: string;
  title?: string;
  name?: string;
  focused?: boolean;
}

export interface TerminalAgentSummary {
  id: string;
  display_name: string;
  icon?: string;
  executable_name?: string;
  argv?: string[];
}

export interface CreateWorkspaceParams {
  title?: string;
  cwd?: string;
  projectId?: string;
  terminalAgentId?: string;
  createWorktree?: boolean;
  worktreeBranch?: string;
  allowDirty?: boolean;
  promptText?: string;
  planMode?: boolean;
}

export interface CreateWorkspaceResult {
  window_id?: string | null;
  workspace_id: string;
  workspace_ref?: string;
}

export interface CloseWorkspaceResult {
  window_id?: string | null;
  workspace_id: string;
  workspace_ref?: string;
}

export interface JiraTicketSummary {
  workspace_id?: string;
  key: string;
  status?: string | null;
  url?: string | null;
  reported_at?: string | null;
}

export interface WorkspaceRunTargetSummary {
  label: string;
  status?: string | null;
  url?: string | null;
  reported_at?: string | null;
}

export interface PullRequestSummary {
  number: number;
  label?: string | null;
  url: string;
  status?: string | null;
  display_status?: string | null;
  status_detail?: string | null;
  branch?: string | null;
  base_branch?: string | null;
  stale?: boolean;
}

export type WorkspaceChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | string;

export type WorkspaceDiffLineKind = "context" | "add" | "delete" | "meta" | string;

export interface WorkspaceDiffLine {
  kind: WorkspaceDiffLineKind;
  old_line?: number;
  new_line?: number;
  text: string;
}

export interface WorkspaceDiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: WorkspaceDiffLine[];
}

export interface WorkspaceChangeFile {
  path: string;
  old_path?: string | null;
  status: WorkspaceChangeStatus;
  binary?: boolean;
  additions?: number;
  deletions?: number;
  patch_truncated?: boolean;
  hunks?: WorkspaceDiffHunk[];
}

export interface WorkspaceChangesResult {
  workspace_id?: string | null;
  title?: string;
  branch?: string | null;
  worktree_path?: string | null;
  git_dirty: boolean;
  git_change_count: number;
  files: WorkspaceChangeFile[];
}

export type TaskColumnId =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | string;

export type TaskProvisionState = "none" | "pending" | "ready" | "failed";

export interface TaskColumnSummary {
  id: TaskColumnId;
  title: string;
  remote_status_label?: string | null;
}

export interface TaskRecord {
  id: string;
  project_id: string;
  title: string;
  brief?: string | null;
  origin: "manual" | "worktree" | "remote" | string;
  column_id: TaskColumnId;
  column_title: string;
  rank: string;
  workspace_id?: string | null;
  worktree_path?: string | null;
  branch?: string | null;
  owns_worktree: boolean;
  provision_state: TaskProvisionState;
  provision_failure_reason?: string | null;
  remote_provider?: string | null;
  remote_key?: string | null;
  remote_url?: string | null;
  remote_status_label?: string | null;
  remote_description?: string | null;
  task_file_path?: string | null;
  git_dirty?: boolean;
  git_change_count?: number;
  pull_requests?: PullRequestSummary[];
  created_at: number;
  updated_at: number;
  archived_at?: number | null;
}

export interface TaskListResult {
  project_id: string;
  tasks: TaskRecord[];
  columns: TaskColumnSummary[];
  include_archived: boolean;
}

export function taskColumnsFromTasks(
  tasks: TaskRecord[] | null | undefined
): TaskColumnSummary[] {
  const seen = new Set<string>();
  const columns: TaskColumnSummary[] = [];
  for (const task of tasks ?? []) {
    const id = String(task.column_id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    columns.push({
      id,
      title: task.column_title?.trim() || id,
    });
  }
  return columns;
}

export function taskRemoteContextColumns(
  context: TaskRemoteContext | null | undefined
): TaskColumnSummary[] {
  if (!context?.enabled) return [];
  return (context.columns ?? []).filter((column) =>
    Boolean(column.remote_status_label?.trim())
  );
}

export function mergeTaskColumns(
  ...sources: Array<TaskColumnSummary[] | null | undefined>
): TaskColumnSummary[] {
  const indexes = new Map<string, number>();
  const result: TaskColumnSummary[] = [];
  for (const source of sources) {
    for (const column of source ?? []) {
      const id = String(column.id ?? "").trim();
      if (!id) continue;
      const title = column.title?.trim() || id;
      const existingIndex = indexes.get(id);
      if (existingIndex === undefined) {
        indexes.set(id, result.length);
        result.push({
          id,
          title,
          ...(column.remote_status_label !== undefined
            ? { remote_status_label: column.remote_status_label }
            : {}),
        });
        continue;
      }
      const existing = result[existingIndex];
      result[existingIndex] = {
        ...existing,
        title:
          existing.title.trim().length === 0 || existing.title === id
            ? title
            : existing.title,
        remote_status_label:
          existing.remote_status_label ?? column.remote_status_label,
      };
    }
  }
  return result;
}

export interface CreateTaskParams {
  title: string;
  brief?: string;
  columnId?: TaskColumnId;
  projectId?: string;
}

export interface UpdateTaskParams {
  taskId: string;
  title?: string;
  /**
   * Pass `null` to clear, undefined to leave unchanged, string to set.
   */
  brief?: string | null;
  projectId?: string;
}

export interface TaskRemoteContext {
  project_id: string;
  enabled: boolean;
  provider: "jira" | "github" | "gitlab" | string;
  provider_label?: string;
  container?: string | null;
  sync_assigned_enabled: boolean;
  limit: number;
  last_synced_at?: number | null;
  last_error?: string | null;
  is_syncing: boolean;
  last_message?: string | null;
  can_create: boolean;
  can_sync_assigned: boolean;
  cli_available: boolean;
  cli_checking?: boolean;
  cli_executable?: string;
  cli_summary?: string;
  cli_detail?: string | null;
  cli_setup_hint?: string;
  columns?: TaskColumnSummary[];
}

export type RemoteOperationStatus = "running" | "succeeded" | "failed" | string;

export interface RemoteOperation<R = unknown> {
  operation_id: string;
  kind: string;
  status: RemoteOperationStatus;
  project_id?: string;
  task_id?: string | null;
  created_at?: number;
  updated_at?: number;
  result?: R | null;
  error_message?: string | null;
}

export interface RemoteTaskResult {
  task?: TaskRecord;
  context?: TaskRemoteContext;
  tasks?: TaskRecord[];
  message?: string;
}

export interface StartTaskAgentResult {
  task_id: string;
  workspace_id?: string;
  worktree_path?: string | null;
  branch?: string | null;
  status: "ready" | "provisioning" | string;
}

export interface RegisterPushTokenParams {
  deviceToken: string;
  platform: "ios" | "android";
  environment: "development" | "production";
}

function isTerminalSurface(s: SurfaceSummary): boolean {
  return s.kind === "terminal" || s.type === "terminal";
}

/** Returns the focused terminal, else the first terminal, else null. */
export function pickTerminalSurface(
  surfaces: SurfaceSummary[]
): SurfaceSummary | null {
  const terminals = surfaces.filter(isTerminalSurface);
  if (terminals.length === 0) return null;
  return terminals.find((s) => s.focused) ?? terminals[0];
}

export function surfaceLabel(s: SurfaceSummary): string {
  return s.title || s.name || s.kind || "Terminal";
}

const TERMINAL_SURFACE_READY_ATTEMPTS = 40;
const TERMINAL_SURFACE_READY_DELAY_MS = 250;

/**
 * Poll until the workspace exposes a terminal surface that's ready to read.
 * Returns the surface, or null after the attempt budget is exhausted.
 *
 * Used after `workspace.create` / `tasks.start_agent` — the backend creates
 * the workspace synchronously but the terminal surface only appears once
 * Ghostty has spawned and produced its first frame.
 */
export async function waitForTerminalSurface(
  client: Pick<TermLoopClient, "listSurfaces" | "readSurface">,
  workspaceId: string
): Promise<SurfaceSummary | null> {
  for (let attempt = 0; attempt < TERMINAL_SURFACE_READY_ATTEMPTS; attempt++) {
    const surfaces = await client.listSurfaces(workspaceId);
    const surface = pickTerminalSurface(surfaces);
    if (surface) {
      try {
        await client.readSurface(workspaceId, surface.id, "vt", 20);
        return surface;
      } catch (err) {
        if (!isTerminalSurfaceStartingError(err)) throw err;
      }
    }
    if (attempt < TERMINAL_SURFACE_READY_ATTEMPTS - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, TERMINAL_SURFACE_READY_DELAY_MS)
      );
    }
  }
  return null;
}

export type SurfaceFormat = "plain" | "vt";

export interface SurfaceText {
  workspaceId: string;
  surfaceId?: string;
  text: string;
  cursor?: { row: number; col: number };
  rev?: number;
}

export interface PairingPayload {
  type: "termloop.pairing";
  version: number;
  server_name: string;
  host: string;
  alternate_hosts?: string[];
  port: number;
  token: string;
  expires_at: number;
}

export interface PairingClaimResult {
  authenticated: true;
  device_id: string;
  device_name: string;
  access_token: string;
  server_name: string;
  capabilities: string[];
}

export interface AuthResult {
  authenticated: true;
  device_id?: string;
  device_name?: string;
  server_name?: string;
  capabilities?: string[];
}

// ---- Transport -----------------------------------------------------------

export interface Transport {
  send<R = unknown>(req: RpcRequest): Promise<RpcResponse<R>>;
  /**
   * Single-owner setter (last-writer-wins): sets the handler that
   * receives server-pushed event lines (no `id`/`ok` field). Calling
   * twice silently replaces the previous handler.
   */
  setEventHandler?(handler: (event: unknown) => void): void;
  /**
   * Single-owner setter (last-writer-wins): notified once when the
   * underlying socket drops. `err === null` means a clean close
   * initiated by `close()`; an Error indicates an unexpected drop. The
   * client uses this to fail outstanding stream subscriptions so the UI
   * doesn't appear "live but frozen".
   */
  setCloseHandler?(handler: (err: Error | null) => void): void;
  close?(): Promise<void>;
}

// ---- Server events -------------------------------------------------------

export type SurfaceEvent =
  | { type: "surface.output"; subscription_id: string; text: string }
  | { type: "surface.snapshot"; subscription_id: string; text: string }
  | { type: "surface.closed"; subscription_id: string }
  | { type: "surface.error"; subscription_id: string; message: string };

export interface SurfaceSubscription {
  subscriptionId: string;
  unsubscribe(): Promise<void>;
}

function parseSurfaceEvent(raw: unknown): SurfaceEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.type !== "string" || typeof o.subscription_id !== "string") {
    return null;
  }
  switch (o.type) {
    case "surface.output":
    case "surface.snapshot":
      return typeof o.text === "string" ? (o as SurfaceEvent) : null;
    case "surface.closed":
      return o as SurfaceEvent;
    case "surface.error":
      return typeof o.message === "string" ? (o as SurfaceEvent) : null;
    default:
      return null;
  }
}

// ---- Client --------------------------------------------------------------

export interface TermLoopClient {
  ping(): Promise<PingResult>;
  claimPairing(
    payload: PairingPayload,
    deviceName: string,
    existingDeviceId?: string
  ): Promise<PairingClaimResult>;
  authWithToken(deviceId: string, accessToken: string): Promise<AuthResult>;
  authWithPassword(password: string): Promise<AuthResult>;
  listProjects(): Promise<ProjectSummary[]>;
  currentProject(): Promise<ProjectSummary | null>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  createWorkspace(params: CreateWorkspaceParams): Promise<CreateWorkspaceResult>;
  closeWorkspace(workspaceId: string): Promise<CloseWorkspaceResult>;
  getWorkspaceChanges(params: {
    workspaceId?: string;
    worktreePath?: string;
    name?: string;
    branch?: string;
    includePatch?: boolean;
    filePath?: string;
    maxPatchBytes?: number;
  }): Promise<WorkspaceChangesResult>;
  listTerminalAgents(): Promise<TerminalAgentSummary[]>;
  registerPushToken(params: RegisterPushTokenParams): Promise<void>;
  getJiraTicket(workspaceId: string): Promise<JiraTicketSummary | null>;
  getRunTargets(workspaceId: string): Promise<WorkspaceRunTargetSummary[]>;
  listSurfaces(workspaceId: string): Promise<SurfaceSummary[]>;
  readSurface(
    workspaceId: string,
    surfaceId?: string,
    format?: SurfaceFormat,
    historyLines?: number
  ): Promise<SurfaceText>;
  sendText(workspaceId: string, text: string, surfaceId?: string): Promise<void>;
  sendKey(workspaceId: string, key: string, surfaceId?: string): Promise<void>;
  /**
   * Subscribe to live surface events. Resolves once the backend assigns a
   * subscription_id; events for that id are routed to `listener` until
   * `unsubscribe()` is called or the transport closes. Throws if the
   * backend rejects the subscribe call (caller should fall back to polling).
   *
   * `format: "vt"` asks the backend to emit ANSI/VT-styled text;
   * `"plain"` (the default) gets stripped output.
   */
  subscribeSurface(
    workspaceId: string,
    surfaceId: string | undefined,
    listener: (event: SurfaceEvent) => void,
    format?: SurfaceFormat,
    historyLines?: number
  ): Promise<SurfaceSubscription>;
  /** No real backend support yet — TODO once PTY resize lands. */
  resize(_params: { workspaceId: string; cols: number; rows: number }): Promise<void>;

  // ---- Tasks (project task board) ---------------------------------------
  listTasks(params?: { projectId?: string; includeArchived?: boolean }): Promise<TaskListResult>;
  getTask(params: {
    taskId: string;
    projectId?: string;
  }): Promise<{ task: TaskRecord; columns: TaskColumnSummary[] }>;
  createTask(params: CreateTaskParams): Promise<TaskRecord>;
  updateTask(params: UpdateTaskParams): Promise<TaskRecord>;
  moveTask(params: {
    taskId: string;
    columnId: TaskColumnId;
    projectId?: string;
  }): Promise<void>;
  archiveTask(params: { taskId: string; projectId?: string }): Promise<void>;
  startTaskAgent(params: {
    taskId: string;
    terminalAgentId?: string;
    projectId?: string;
    allowDirty?: boolean;
    promptText?: string;
    planMode?: boolean;
  }): Promise<StartTaskAgentResult>;
  getTaskRemoteContext(params?: { projectId?: string }): Promise<TaskRemoteContext>;
  getRemoteOperation(operationId: string): Promise<RemoteOperation<RemoteTaskResult>>;
  waitRemoteOperation(
    operationId: string,
    timeoutMs?: number
  ): Promise<RemoteOperation<RemoteTaskResult>>;
  createRemoteTask(params: {
    title: string;
    bodyMarkdown?: string;
    issueType?: string;
    projectId?: string;
  }): Promise<RemoteOperation<RemoteTaskResult>>;
  linkTaskRemoteItem(params: {
    taskId: string;
    input: string;
    projectId?: string;
  }): Promise<RemoteOperation<RemoteTaskResult>>;
  unlinkTaskRemoteItem(params: {
    taskId: string;
    projectId?: string;
  }): Promise<RemoteTaskResult>;
  refreshTaskRemoteItem(params: {
    taskId: string;
    projectId?: string;
  }): Promise<RemoteOperation<RemoteTaskResult>>;
  syncAssignedRemoteTasks(params?: {
    projectId?: string;
  }): Promise<RemoteOperation<RemoteTaskResult>>;
  refreshLinkedRemoteTasks(params?: {
    projectId?: string;
  }): Promise<RemoteOperation<RemoteTaskResult>>;
  updateTaskRemoteStatus(params: {
    taskId: string;
    columnId: TaskColumnId;
    projectId?: string;
  }): Promise<RemoteOperation<RemoteTaskResult>>;

  close(): Promise<void>;
}

export class RpcCallError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "RpcCallError";
    this.code = code;
    this.data = data;
  }
}

let nextId = 0;
const newId = (): RequestId => `req_${++nextId}`;

function unwrap<R>(resp: RpcResponse<R>): R {
  if (!resp.ok) {
    throw new RpcCallError(resp.error.code, resp.error.message, resp.error.data);
  }
  return resp.result;
}

function withSurface(
  workspaceId: string,
  surfaceId: string | undefined,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    ...(surfaceId ? { surface_id: surfaceId } : {}),
    ...extra,
  };
}

export function createTermLoopClient(opts: {
  transport: Transport;
}): TermLoopClient {
  const { transport } = opts;
  const call = async <R>(method: string, params?: unknown): Promise<R> => {
    const resp = await transport.send<R>({ id: newId(), method, params });
    return unwrap(resp);
  };
  const callRemoteOperation = async (
    method: string,
    params?: unknown
  ): Promise<RemoteOperation<RemoteTaskResult>> => {
    const out = await call<{ operation: RemoteOperation<RemoteTaskResult> }>(
      method,
      params
    );
    return out.operation;
  };

  const listeners = new Map<string, (e: SurfaceEvent) => void>();
  const orphans = new Map<string, SurfaceEvent[]>();
  // Misbehaving backend could spew events for unknown subscription_ids;
  // bound the orphan cache so it can't grow without limit.
  const MAX_ORPHAN_EVENTS_PER_SUB = 32;
  const MAX_ORPHAN_SUBSCRIPTIONS = 16;

  transport.setEventHandler?.((raw: unknown) => {
    const event = parseSurfaceEvent(raw);
    if (!event) return;
    const listener = listeners.get(event.subscription_id);
    if (listener) {
      listener(event);
      return;
    }
    let buf = orphans.get(event.subscription_id);
    if (!buf) {
      if (orphans.size >= MAX_ORPHAN_SUBSCRIPTIONS) {
        const oldestKey = orphans.keys().next().value;
        if (oldestKey !== undefined) orphans.delete(oldestKey);
      }
      buf = [];
      orphans.set(event.subscription_id, buf);
    }
    buf.push(event);
    if (buf.length > MAX_ORPHAN_EVENTS_PER_SUB) buf.shift();
  });

  transport.setCloseHandler?.((err) => {
    // Tell every active stream subscriber that the pipe is gone. They
    // can react (degrade to polling, surface a banner) rather than
    // silently freezing.
    const message = err
      ? `Transport closed: ${err.message}`
      : "Transport closed";
    const snapshot = Array.from(listeners.entries());
    listeners.clear();
    orphans.clear();
    for (const [subId, listener] of snapshot) {
      try {
        listener({
          type: "surface.error",
          subscription_id: subId,
          message,
        });
      } catch {
        /* ignore listener errors */
      }
    }
  });

  return {
    async ping() {
      return call<PingResult>("system.ping");
    },
    async claimPairing(payload, deviceName, existingDeviceId) {
      return call<PairingClaimResult>("pairing.claim", {
        token: payload.token,
        device_name: deviceName,
        ...(existingDeviceId ? { device_id: existingDeviceId } : {}),
      });
    },
    async authWithToken(deviceId, accessToken) {
      return call<AuthResult>("auth.token", {
        device_id: deviceId,
        access_token: accessToken,
      });
    },
    async authWithPassword(password) {
      return call<AuthResult>("auth.login", { password });
    },
    async listProjects() {
      const out = await call<{ projects?: ProjectSummary[] }>("project.list");
      return out?.projects ?? [];
    },
    async currentProject() {
      try {
        const out = await call<ProjectSummary | null>("project.current");
        return out ?? null;
      } catch (err) {
        if (err instanceof RpcCallError && err.code === "not_found") return null;
        throw err;
      }
    },
    async listWorkspaces() {
      const out = await call<{ workspaces?: WorkspaceSummary[] }>(
        "workspace.list"
      );
      return out?.workspaces ?? [];
    },
    async createWorkspace(params) {
      return call<CreateWorkspaceResult>("workspace.create", {
        ...(params.title ? { title: params.title } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.projectId ? { project_id: params.projectId } : {}),
        ...(params.terminalAgentId
          ? { terminal_agent_id: params.terminalAgentId }
          : {}),
        ...(params.createWorktree ? { create_worktree: true } : {}),
        ...(params.worktreeBranch
          ? { worktree_branch: params.worktreeBranch }
          : {}),
        ...(params.allowDirty ? { allow_dirty: true } : {}),
        ...(params.promptText ? { prompt_text: params.promptText } : {}),
        ...(params.planMode ? { permission_mode: "plan" } : {}),
      });
    },
    async closeWorkspace(workspaceId) {
      return call<CloseWorkspaceResult>("workspace.close", {
        workspace_id: workspaceId,
      });
    },
    async getWorkspaceChanges(params) {
      return call<WorkspaceChangesResult>("workspace.changes", {
        ...(params.workspaceId ? { workspace_id: params.workspaceId } : {}),
        ...(params.worktreePath ? { worktree_path: params.worktreePath } : {}),
        ...(params.name ? { name: params.name } : {}),
        ...(params.branch ? { branch: params.branch } : {}),
        ...(params.includePatch ? { include_patch: true } : {}),
        ...(params.filePath ? { file_path: params.filePath } : {}),
        ...(params.maxPatchBytes ? { max_patch_bytes: params.maxPatchBytes } : {}),
      });
    },
    async listTerminalAgents() {
      const out = await call<{ agents?: TerminalAgentSummary[] }>(
        "termloop.list_terminal_agents"
      );
      return out?.agents ?? [];
    },
    async registerPushToken(params) {
      await call<{ registered?: boolean }>("push.register", {
        device_token: params.deviceToken,
        platform: params.platform,
        environment: params.environment,
      });
    },
    async getJiraTicket(workspaceId) {
      try {
        const out = await call<{
          set?: boolean;
          workspace_id?: string;
          key?: string;
          status?: string | null;
          url?: string | null;
          reported_at?: string | null;
        }>("workspace.get_jira_ticket", { workspace_id: workspaceId });
        if (out?.set === false || !out?.key) return null;
        return {
          workspace_id: out.workspace_id,
          key: out.key,
          status: out.status ?? null,
          url: out.url ?? null,
          reported_at: out.reported_at ?? null,
        };
      } catch (err) {
        if (
          err instanceof RpcCallError &&
          (err.code === "not_found" || err.code === "no_worktree")
        ) {
          return null;
        }
        throw err;
      }
    },
    async getRunTargets(workspaceId) {
      try {
        const out = await call<{ targets?: WorkspaceRunTargetSummary[] }>(
          "workspace.get_run_targets",
          { workspace_id: workspaceId }
        );
        return out?.targets ?? [];
      } catch (err) {
        if (
          err instanceof RpcCallError &&
          (err.code === "not_found" || err.code === "no_worktree")
        ) {
          return [];
        }
        throw err;
      }
    },
    async listSurfaces(workspaceId) {
      const out = await call<{ surfaces?: SurfaceSummary[] }>("surface.list", {
        workspace_id: workspaceId,
      });
      return out?.surfaces ?? [];
    },
    async readSurface(workspaceId, surfaceId, format, historyLines) {
      return call<SurfaceText>(
        "surface.read_text",
        withSurface(workspaceId, surfaceId, {
          ...(format ? { format } : {}),
          ...(historyLines ? { history_lines: historyLines } : {}),
        })
      );
    },
    async sendText(workspaceId, text, surfaceId) {
      await call<{ ok: true }>(
        "surface.send_text",
        withSurface(workspaceId, surfaceId, { text })
      );
    },
    async sendKey(workspaceId, key, surfaceId) {
      await call<{ ok: true }>(
        "surface.send_key",
        withSurface(workspaceId, surfaceId, { key })
      );
    },
    async resize(_params) {
      // No-op until backend exposes a PTY resize API.
    },
    async listTasks(params) {
      return call<TaskListResult>("tasks.list", {
        ...(params?.projectId ? { project_id: params.projectId } : {}),
        ...(params?.includeArchived ? { include_archived: true } : {}),
      });
    },
    async getTask(params) {
      return call<{ task: TaskRecord; columns: TaskColumnSummary[] }>(
        "tasks.get",
        {
          task_id: params.taskId,
          ...(params.projectId ? { project_id: params.projectId } : {}),
        }
      );
    },
    async createTask(params) {
      const out = await call<{ task: TaskRecord }>("tasks.create", {
        title: params.title,
        ...(params.brief !== undefined ? { brief: params.brief } : {}),
        ...(params.columnId ? { column_id: params.columnId } : {}),
        ...(params.projectId ? { project_id: params.projectId } : {}),
      });
      return out.task;
    },
    async updateTask(params) {
      const wire: Record<string, unknown> = { task_id: params.taskId };
      if (params.title !== undefined) wire.title = params.title;
      if (params.brief !== undefined) wire.brief = params.brief ?? "";
      if (params.projectId) wire.project_id = params.projectId;
      const out = await call<{ task: TaskRecord }>("tasks.update", wire);
      return out.task;
    },
    async moveTask(params) {
      await call<{ ok: true }>("tasks.move", {
        task_id: params.taskId,
        column_id: params.columnId,
        ...(params.projectId ? { project_id: params.projectId } : {}),
      });
    },
    async archiveTask(params) {
      await call<{ ok: true }>("tasks.archive", {
        task_id: params.taskId,
        ...(params.projectId ? { project_id: params.projectId } : {}),
      });
    },
    async startTaskAgent(params) {
      return call<StartTaskAgentResult>("tasks.start_agent", {
        task_id: params.taskId,
        ...(params.terminalAgentId
          ? { terminal_agent_id: params.terminalAgentId }
          : {}),
        ...(params.projectId ? { project_id: params.projectId } : {}),
        ...(params.allowDirty ? { allow_dirty: true } : {}),
        ...(params.promptText ? { prompt_text: params.promptText } : {}),
        ...(params.planMode ? { permission_mode: "plan" } : {}),
      });
    },
    async getTaskRemoteContext(params) {
      return call<TaskRemoteContext>("tasks.remote_context", {
        ...(params?.projectId ? { project_id: params.projectId } : {}),
      });
    },
    async getRemoteOperation(operationId) {
      return callRemoteOperation("tasks.remote_operation", {
        operation_id: operationId,
      });
    },
    async waitRemoteOperation(operationId, timeoutMs = 45_000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const op = await callRemoteOperation("tasks.remote_operation", {
          operation_id: operationId,
        });
        if (op.status === "succeeded") return op;
        if (op.status === "failed") {
          throw new Error(op.error_message || "Remote operation failed");
        }
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      throw new Error("Timed out waiting for remote operation");
    },
    async createRemoteTask(params) {
      return callRemoteOperation(
        "tasks.remote_create",
        {
          title: params.title,
          ...(params.bodyMarkdown ? { body_markdown: params.bodyMarkdown } : {}),
          ...(params.issueType ? { issue_type: params.issueType } : {}),
          ...(params.projectId ? { project_id: params.projectId } : {}),
        }
      );
    },
    async linkTaskRemoteItem(params) {
      return callRemoteOperation(
        "tasks.remote_link",
        {
          task_id: params.taskId,
          input: params.input,
          ...(params.projectId ? { project_id: params.projectId } : {}),
        }
      );
    },
    async unlinkTaskRemoteItem(params) {
      return call<RemoteTaskResult>("tasks.remote_unlink", {
        task_id: params.taskId,
        ...(params.projectId ? { project_id: params.projectId } : {}),
      });
    },
    async refreshTaskRemoteItem(params) {
      return callRemoteOperation(
        "tasks.remote_refresh",
        {
          task_id: params.taskId,
          ...(params.projectId ? { project_id: params.projectId } : {}),
        }
      );
    },
    async syncAssignedRemoteTasks(params) {
      return callRemoteOperation(
        "tasks.remote_sync_assigned",
        {
          ...(params?.projectId ? { project_id: params.projectId } : {}),
        }
      );
    },
    async refreshLinkedRemoteTasks(params) {
      return callRemoteOperation(
        "tasks.remote_refresh_linked",
        {
          ...(params?.projectId ? { project_id: params.projectId } : {}),
        }
      );
    },
    async updateTaskRemoteStatus(params) {
      return callRemoteOperation(
        "tasks.remote_update_status",
        {
          task_id: params.taskId,
          column_id: params.columnId,
          ...(params.projectId ? { project_id: params.projectId } : {}),
        }
      );
    },
    async subscribeSurface(workspaceId, surfaceId, listener, format, historyLines) {
      const out = await call<{ subscription_id: string }>(
        "surface.subscribe",
        withSurface(workspaceId, surfaceId, {
          ...(format ? { format } : {}),
          ...(historyLines ? { history_lines: historyLines } : {}),
        })
      );
      const subId = out.subscription_id;
      listeners.set(subId, listener);
      const drained = orphans.get(subId);
      if (drained) {
        orphans.delete(subId);
        for (const e of drained) listener(e);
      }
      return {
        subscriptionId: subId,
        unsubscribe: async () => {
          listeners.delete(subId);
          orphans.delete(subId);
          try {
            await call<{ ok: true }>("surface.unsubscribe", {
              subscription_id: subId,
            });
          } catch {
            /* best effort — transport may already be closed */
          }
        },
      };
    },
    async close() {
      listeners.clear();
      orphans.clear();
      await transport.close?.();
    },
  };
}

// ---- Pairing payload validation -----------------------------------------

export function parsePairingPayload(raw: string): PairingPayload {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("Pairing payload is not valid JSON.");
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("Pairing payload must be a JSON object.");
  }
  const o = obj as Record<string, unknown>;
  if (o.type !== "termloop.pairing") {
    throw new Error("Pairing payload type mismatch.");
  }
  if (typeof o.version !== "number") {
    throw new Error("Pairing payload missing version.");
  }
  if (typeof o.host !== "string" || !o.host) {
    throw new Error("Pairing payload missing host.");
  }
  if (
    o.alternate_hosts !== undefined &&
    (!Array.isArray(o.alternate_hosts) ||
      o.alternate_hosts.some((item) => typeof item !== "string"))
  ) {
    throw new Error("Pairing payload has invalid alternate_hosts.");
  }
  if (typeof o.port !== "number" || !Number.isFinite(o.port)) {
    throw new Error("Pairing payload missing/invalid port.");
  }
  if (typeof o.token !== "string" || !o.token) {
    throw new Error("Pairing payload missing token.");
  }
  if (typeof o.server_name !== "string") {
    throw new Error("Pairing payload missing server_name.");
  }
  if (typeof o.expires_at !== "number") {
    throw new Error("Pairing payload missing expires_at.");
  }
  if (o.expires_at * 1000 < Date.now()) {
    throw new Error("Pairing token has expired.");
  }
  return {
    ...(o as unknown as PairingPayload),
    alternate_hosts: connectionHostCandidates({
      host: o.host as string,
      alternateHosts: o.alternate_hosts as string[] | undefined,
    }).slice(1),
  };
}

export function pairingHostCandidates(payload: PairingPayload): string[] {
  return connectionHostCandidates({
    host: payload.host,
    alternateHosts: payload.alternate_hosts,
  });
}
