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
  close?(): Promise<void>;
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
    async close() {
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
