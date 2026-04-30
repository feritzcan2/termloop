import * as TermLoop from '../modules/expo-termloop';

export type TermLoopClientState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'error';

export interface TermLoopProject {
  id: string;
  name: string;
  folder_path: string;
  created_at: number;
  active: boolean;
  open: boolean;
}

export interface TermLoopProjectListResult {
  projects: TermLoopProject[];
  active_project_id: string | null;
  open_project_ids: string[];
}

export type TerminalAgentId = 'claude' | 'codex' | 'gemini' | 'opencode' | string;

export type AgentActivityPhase =
  | 'inactive'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'failed';

export type AgentAttentionKind =
  | 'completion'
  | 'notification'
  | 'permission'
  | 'userInput'
  | 'error';

export interface TermLoopWorkspace {
  id: string;
  title: string;
  project_id: string | null;
  current_directory?: string | null;
  branch?: string | null;
  worktree_path?: string | null;
  git_dirty?: boolean | null;
  git_change_count?: number | null;

  /** Claude-specific (legacy / Claude-only clients). */
  claude_session_id?: string | null;
  claude_cwd?: string | null;
  claude_running?: boolean | null;
  claude_hooks_installed?: boolean | null;

  /** Agent-agnostic fields from TerminalAgentActivityStore + WorkspaceMetadataStore. */
  terminal_agent_id?: TerminalAgentId | null;
  agent_activity_phase?: AgentActivityPhase | null;
  agent_attention_kind?: AgentAttentionKind | null;
  agent_activity_preview?: string | null;
  agent_activity_updated_at?: number | null;

  awaiting_input_since?: number | null;
  last_message_preview?: string | null;
  last_message_kind?: 'stop' | 'notification' | null;
}

export type TermLoopGitChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export interface TermLoopGitChange {
  path: string;
  status: TermLoopGitChangeStatus;
}

export interface TermLoopWorkspaceChangesResult {
  workspace_id: string;
  title: string;
  branch?: string | null;
  worktree_path?: string | null;
  git_dirty: boolean;
  git_change_count: number;
  files: TermLoopGitChange[];
}

export interface TermLoopKillClaudeResult {
  killed: boolean;
  pid?: number;
  session_id?: string;
  reason?: 'no_session' | 'no_pid' | string;
}

export interface TermLoopSpawnClaudeResult {
  spawned: boolean;
  workspace_id?: string;
  session_id?: string;
  surface_id?: string;
  reason?: string;
  resume_prepared?: boolean;
}

export interface TermLoopPrepareClaudeResumeResult {
  prepared: boolean;
  workspace_id?: string;
  session_id?: string;
  cwd?: string | null;
  reason?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface TermLoopErrorShape {
  code?: string;
  message?: string;
}

export class TermLoopRpcError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'TermLoopRpcError';
    this.code = code;
  }
}

export function formatRpcError(e: unknown): string {
  if (e instanceof TermLoopRpcError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

export class TermLoopClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private messageSub: { remove: () => void } | null = null;
  private disconnectSub: { remove: () => void } | null = null;
  private readonly stateListeners = new Set<(state: TermLoopClientState) => void>();
  private state: TermLoopClientState = 'idle';

  private eventListeners = new Map<string, Set<(data: any) => void>>();

  // Reconnect fields (D2)
  private reconnectAttempts = 0;
  private readonly maxBackoffMs = 30_000;
  private reconnectCredentials: { host: string; port: number; password: string } | null = null;
  private readonly onReconnectCallbacks = new Set<() => void>();

  get currentState(): TermLoopClientState {
    return this.state;
  }

  onStateChange(cb: (state: TermLoopClientState) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  private setState(next: TermLoopClientState) {
    this.state = next;
    this.stateListeners.forEach((cb) => {
      try {
        cb(next);
      } catch {
        // listener threw — swallow so other listeners keep firing
      }
    });
  }

  async connect(host: string, port: number, password: string): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'disconnected' && this.state !== 'error') {
      throw new Error(`connect() called in state=${this.state}`);
    }

    this.setState('connecting');
    let sessionId: string;
    try {
      sessionId = await TermLoop.connect(host, port);
    } catch (err: any) {
      this.setState('error');
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.sessionId = sessionId;
    // Store credentials for reconnect
    this.reconnectCredentials = { host, port, password };

    this.messageSub = TermLoop.onMessage((event) => {
      if (event.sessionId !== this.sessionId) return;
      this.handleIncomingLine(event.line);
    });

    this.disconnectSub = TermLoop.onDisconnect((event) => {
      if (event.sessionId !== this.sessionId) return;
      this.failAllPending(new Error(event.error ?? 'connection closed'));
      this.teardownSubs();
      this.sessionId = null;
      this.setState('disconnected');
      // Attempt reconnect if we have credentials (D2)
      if (this.reconnectCredentials) {
        const { host: h, port: p, password: pw } = this.reconnectCredentials;
        this.scheduleReconnect(h, p, pw);
      }
    });

    this.setState('authenticating');
    try {
      await this.rpc<{ authenticated: boolean }>('auth.login', { password });
    } catch (err) {
      await this.disconnect().catch(() => {});
      this.setState('error');
      throw err;
    }
    this.reconnectAttempts = 0;
    this.setState('ready');
  }

  listProjects(): Promise<TermLoopProjectListResult> {
    return this.rpc<TermLoopProjectListResult>('project.list');
  }

  currentProject(): Promise<TermLoopProject> {
    return this.rpc<TermLoopProject>('project.current');
  }

  switchProject(projectId: string): Promise<TermLoopProject> {
    return this.rpc<TermLoopProject>('project.switch', { project_id: projectId });
  }

  listWorkspaces(): Promise<{ workspaces: TermLoopWorkspace[] }> {
    return this.rpc<{ workspaces: TermLoopWorkspace[] }>('workspace.list');
  }

  workspaceChanges(workspaceId: string): Promise<TermLoopWorkspaceChangesResult> {
    return this.rpc<TermLoopWorkspaceChangesResult>('workspace.changes', { workspace_id: workspaceId });
  }

  killClaudeSession(
    workspaceId: string,
    options?: { force?: boolean }
  ): Promise<TermLoopKillClaudeResult> {
    const params: Record<string, unknown> = { workspace_id: workspaceId };
    if (options?.force) params.force = true;
    return this.rpc<TermLoopKillClaudeResult>('workspace.kill_claude_session', params);
  }

  spawnClaudeInWorkspace(
    workspaceId: string,
    sessionId: string,
    cwd?: string | null
  ): Promise<TermLoopSpawnClaudeResult> {
    const params: Record<string, unknown> = {
      workspace_id: workspaceId,
      session_id: sessionId,
    };
    if (cwd) params.cwd = cwd;
    return this.rpc<TermLoopSpawnClaudeResult>('workspace.spawn_claude_session', params);
  }

  prepareClaudeResume(
    workspaceId: string,
    sessionId: string,
    options?: { cwd?: string | null; sourceCwd?: string | null }
  ): Promise<TermLoopPrepareClaudeResumeResult> {
    const params: Record<string, unknown> = {
      workspace_id: workspaceId,
      session_id: sessionId,
    };
    if (options?.cwd) params.cwd = options.cwd;
    if (options?.sourceCwd) params.source_cwd = options.sourceCwd;
    return this.rpc<TermLoopPrepareClaudeResumeResult>('workspace.prepare_claude_resume', params);
  }

  async disconnect(): Promise<void> {
    const sid = this.sessionId;
    // Clear reconnect credentials so auto-reconnect does not fire on explicit disconnect
    this.reconnectCredentials = null;
    this.teardownSubs();
    this.failAllPending(new Error('client disconnected'));
    this.sessionId = null;
    if (sid) {
      try {
        await TermLoop.disconnect(sid);
      } catch {
        // disconnect best-effort
      }
    }
    this.setState('disconnected');
  }

  private rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const sid = this.sessionId;
    if (!sid) {
      return Promise.reject(new Error('not connected'));
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
    });
    const payload = params === undefined
      ? JSON.stringify({ method, id })
      : JSON.stringify({ method, params, id });
    TermLoop.send(sid, payload).catch((err) => {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return promise;
  }

  private handleIncomingLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (typeof msg.event === 'string') {
      this.handleEventFrame(msg);
      return;
    }

    if (typeof msg.id !== 'number') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.ok === true) {
      pending.resolve(msg.result);
    } else {
      const err = msg.error as TermLoopErrorShape | undefined;
      pending.reject(new TermLoopRpcError(err?.message ?? 'termloop error', err?.code ?? 'unknown'));
    }
  }

  onEvent(type: string, listener: (data: any) => void): () => void {
    let set = this.eventListeners.get(type);
    if (!set) {
      set = new Set();
      this.eventListeners.set(type, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  private handleEventFrame(msg: { event: string; data?: unknown }) {
    if (msg.event === 'ping') return;
    const listeners = this.eventListeners.get(msg.event);
    if (!listeners) return;
    for (const l of listeners) {
      try {
        l(msg.data);
      } catch (e) {
        console.warn('termloop event listener threw', e);
      }
    }
  }

  async subscribeEvents(opts?: { types?: string[]; workspaceIds?: string[] }): Promise<string> {
    const params: Record<string, unknown> = {};
    if (opts?.types && opts.types.length) params.types = opts.types;
    if (opts?.workspaceIds && opts.workspaceIds.length) params.workspace_ids = opts.workspaceIds;
    const res = await this.rpc<{ subscription_id: string }>('events.subscribe', params);
    return res.subscription_id;
  }

  async unsubscribeEvents(subscriptionId?: string): Promise<void> {
    const params = subscriptionId ? { subscription_id: subscriptionId } : {};
    await this.rpc('events.unsubscribe', params);
  }

  onReconnect(cb: () => void): () => void {
    this.onReconnectCallbacks.add(cb);
    return () => { this.onReconnectCallbacks.delete(cb); };
  }

  private scheduleReconnect(host: string, port: number, password: string) {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxBackoffMs);
    this.reconnectAttempts++;
    setTimeout(() => {
      this.connect(host, port, password)
        .then(() => {
          this.reconnectAttempts = 0;
          for (const cb of this.onReconnectCallbacks) {
            try { cb(); } catch (err) { console.warn('[termloop] onReconnect callback threw', err); }
          }
        })
        .catch(() => this.scheduleReconnect(host, port, password));
    }, delay);
  }

  async surfaceSendText(workspaceId: string, text: string): Promise<void> {
    await this.rpc('surface.send_text', { workspace_id: workspaceId, text });
  }

  /**
   * Read text from the workspace's focused terminal surface. With `lines` set,
   * returns the last N lines from visible screen + scrollback. Used by the
   * mobile chat screen to hydrate history before subscribing to live events.
   */
  async surfaceReadText(
    workspaceId: string,
    options?: { lines?: number; surfaceId?: string }
  ): Promise<{ text: string; surfaceId: string }> {
    const params: Record<string, unknown> = { workspace_id: workspaceId };
    if (options?.lines && options.lines > 0) {
      params.scrollback = true;
      params.lines = options.lines;
    } else {
      params.scrollback = true;
    }
    if (options?.surfaceId) params.surface_id = options.surfaceId;
    const res = await this.rpc<{ text: string; surface_id: string }>(
      'surface.read_text',
      params
    );
    return { text: res.text ?? '', surfaceId: res.surface_id };
  }

  async workspaceClearAttention(workspaceId: string): Promise<void> {
    await this.rpc('workspace.clear_attention', { workspace_id: workspaceId });
  }

  async pushRegister(
    deviceToken: string,
    platform: 'ios' | 'android',
    environment: 'development' | 'production'
  ): Promise<{ registered: boolean }> {
    return this.rpc<{ registered: boolean }>('push.register', {
      device_token: deviceToken,
      platform,
      environment,
    });
  }

  async pushUnregister(deviceToken: string): Promise<{ unregistered: boolean }> {
    return this.rpc<{ unregistered: boolean }>('push.unregister', {
      device_token: deviceToken,
    });
  }

  async workspaceList(): Promise<TermLoopWorkspace[]> {
    const res = await this.listWorkspaces();
    return res.workspaces;
  }

  private failAllPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private teardownSubs() {
    this.messageSub?.remove();
    this.messageSub = null;
    this.disconnectSub?.remove();
    this.disconnectSub = null;
  }
}
