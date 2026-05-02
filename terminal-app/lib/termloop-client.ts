/**
 * TermLoop client — typed request/response envelope and stub methods.
 *
 * Envelope:
 *   request : { id, method, params }
 *   success : { id, ok: true,  result }
 *   error   : { id, ok: false, error: { code: string, message, data? } }
 */

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
}

export interface WorkspaceSummary {
  id: string;
  /** Backend may send `name` or `title`. Read with `workspaceLabel(ws)`. */
  name?: string;
  title?: string;
  projectId?: string;
  project_id?: string;
  agent?: string;
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
    deviceName: string
  ): Promise<PairingClaimResult>;
  authWithToken(deviceId: string, accessToken: string): Promise<AuthResult>;
  authWithPassword(password: string): Promise<AuthResult>;
  listProjects(): Promise<ProjectSummary[]>;
  currentProject(): Promise<ProjectSummary | null>;
  switchProject(projectId: string): Promise<void>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  listSurfaces(workspaceId: string): Promise<SurfaceSummary[]>;
  readSurface(workspaceId: string, surfaceId?: string): Promise<SurfaceText>;
  sendText(workspaceId: string, text: string, surfaceId?: string): Promise<void>;
  sendKey(workspaceId: string, key: string, surfaceId?: string): Promise<void>;
  /**
   * Subscribe to live surface events. Resolves once the backend assigns a
   * subscription_id; events for that id are routed to `listener` until
   * `unsubscribe()` is called or the transport closes. Throws if the
   * backend rejects the subscribe call (caller should fall back to polling).
   */
  subscribeSurface(
    workspaceId: string,
    surfaceId: string | undefined,
    listener: (event: SurfaceEvent) => void
  ): Promise<SurfaceSubscription>;
  /** No real backend support yet — TODO once PTY resize lands. */
  resize(_params: { workspaceId: string; cols: number; rows: number }): Promise<void>;
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
    async claimPairing(payload, deviceName) {
      return call<PairingClaimResult>("pairing.claim", {
        token: payload.token,
        device_name: deviceName,
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
    async switchProject(projectId) {
      await call<{ ok: true }>("project.switch", { project_id: projectId });
    },
    async listWorkspaces() {
      const out = await call<{ workspaces?: WorkspaceSummary[] }>(
        "workspace.list"
      );
      return out?.workspaces ?? [];
    },
    async listSurfaces(workspaceId) {
      const out = await call<{ surfaces?: SurfaceSummary[] }>("surface.list", {
        workspace_id: workspaceId,
      });
      return out?.surfaces ?? [];
    },
    async readSurface(workspaceId, surfaceId) {
      return call<SurfaceText>(
        "surface.read_text",
        withSurface(workspaceId, surfaceId)
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
    async subscribeSurface(workspaceId, surfaceId, listener) {
      const out = await call<{ subscription_id: string }>(
        "surface.subscribe",
        withSurface(workspaceId, surfaceId)
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
  return o as unknown as PairingPayload;
}
