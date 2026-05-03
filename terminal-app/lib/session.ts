import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { connectionHostCandidates, type SavedConnection } from "./connections";
import { TcpTransport } from "./tcp-transport";
import {
  createTermLoopClient,
  type AuthResult,
  RpcCallError,
  type CreateWorkspaceParams,
  type CreateWorkspaceResult,
  type JiraTicketSummary,
  type PairingClaimResult,
  type PairingPayload,
  type ProjectSummary,
  type RegisterPushTokenParams,
  type SurfaceFormat,
  type SurfaceSubscription,
  type SurfaceText,
  type SurfaceSummary,
  type TerminalAgentSummary,
  type TermLoopClient,
  type WorkspaceRunTargetSummary,
  type WorkspaceSummary,
} from "./termloop-client";

interface ConnectedClient {
  client: TermLoopClient;
  auth?: AuthResult;
}

interface ActiveSession {
  connectionId: string;
  client: TermLoopClient;
  conn: SavedConnection;
  current: ConnectedClient;
  auth?: AuthResult;
  reconnectPromise: Promise<void> | null;
  closed: boolean;
}

let active: ActiveSession | null = null;

export interface OpenSessionResult {
  client: TermLoopClient;
  auth?: AuthResult;
}

export async function applyAuth(
  client: TermLoopClient,
  conn: SavedConnection
): Promise<{ auth?: AuthResult; authenticated: boolean }> {
  if (conn.deviceId && conn.accessToken) {
    const auth = await client.authWithToken(conn.deviceId, conn.accessToken);
    return { auth, authenticated: true };
  }
  if (conn.password) {
    const auth = await client.authWithPassword(conn.password);
    return { auth, authenticated: true };
  }
  return { authenticated: false };
}

export async function openSession(
  conn: SavedConnection
): Promise<OpenSessionResult> {
  await closeSession();
  const current = await connectSavedConnection(conn);
  const session: ActiveSession = {
    connectionId: conn.id,
    client: undefined as unknown as TermLoopClient,
    conn,
    current,
    auth: current.auth,
    reconnectPromise: null,
    closed: false,
  };
  session.client = createSessionClient(session);
  active = session;
  void registerPushToken(session.client).catch((err) => {
    console.warn("Push registration skipped:", err);
  });
  return { client: session.client, auth: current.auth };
}

async function connectSavedConnection(
  conn: SavedConnection
): Promise<ConnectedClient> {
  const hosts = connectionHostCandidates(conn);
  let lastErr: unknown = null;

  for (const host of hosts) {
    const transport = new TcpTransport({
      host,
      port: conn.port,
      connectTimeoutMs: hosts.length > 1 ? 3500 : undefined,
    });
    const client = createTermLoopClient({ transport });

    try {
      const { auth } = await applyAuth(client, conn);
      return { client, auth };
    } catch (err) {
      lastErr = err;
      await client.close().catch(() => {});
    }
  }

  throw lastErr ?? new Error("Connection failed.");
}

function createSessionClient(session: ActiveSession): TermLoopClient {
  return {
    ping: () => withReconnect(session, (client) => client.ping()),
    claimPairing: (
      payload: PairingPayload,
      deviceName: string,
      existingDeviceId?: string
    ): Promise<PairingClaimResult> =>
      withReconnect(session, (client) =>
        client.claimPairing(payload, deviceName, existingDeviceId)
      ),
    authWithToken: (deviceId: string, accessToken: string) =>
      withReconnect(session, (client) =>
        client.authWithToken(deviceId, accessToken)
      ),
    authWithPassword: (password: string) =>
      withReconnect(session, (client) => client.authWithPassword(password)),
    listProjects: (): Promise<ProjectSummary[]> =>
      withReconnect(session, (client) => client.listProjects()),
    currentProject: (): Promise<ProjectSummary | null> =>
      withReconnect(session, (client) => client.currentProject()),
    switchProject: (projectId: string) =>
      withReconnect(session, (client) => client.switchProject(projectId)),
    listWorkspaces: (): Promise<WorkspaceSummary[]> =>
      withReconnect(session, (client) => client.listWorkspaces()),
    createWorkspace: (
      params: CreateWorkspaceParams
    ): Promise<CreateWorkspaceResult> =>
      withReconnect(
        session,
        (client) => client.createWorkspace(params),
        "prewrite"
      ),
    listTerminalAgents: (): Promise<TerminalAgentSummary[]> =>
      withReconnect(session, (client) => client.listTerminalAgents()),
    registerPushToken: (params: RegisterPushTokenParams) =>
      withReconnect(session, (client) => client.registerPushToken(params)),
    getJiraTicket: (workspaceId: string): Promise<JiraTicketSummary | null> =>
      withReconnect(session, (client) => client.getJiraTicket(workspaceId)),
    getRunTargets: (
      workspaceId: string
    ): Promise<WorkspaceRunTargetSummary[]> =>
      withReconnect(session, (client) => client.getRunTargets(workspaceId)),
    listSurfaces: (workspaceId: string): Promise<SurfaceSummary[]> =>
      withReconnect(session, (client) => client.listSurfaces(workspaceId)),
    readSurface: (
      workspaceId: string,
      surfaceId?: string,
      format?: SurfaceFormat,
      historyLines?: number
    ): Promise<SurfaceText> =>
      withReconnect(session, (client) =>
        client.readSurface(workspaceId, surfaceId, format, historyLines)
      ),
    sendText: (workspaceId: string, text: string, surfaceId?: string) =>
      withReconnect(
        session,
        (client) => client.sendText(workspaceId, text, surfaceId),
        "prewrite"
      ),
    sendKey: (workspaceId: string, key: string, surfaceId?: string) =>
      withReconnect(
        session,
        (client) => client.sendKey(workspaceId, key, surfaceId),
        "prewrite"
      ),
    subscribeSurface: (
      workspaceId: string,
      surfaceId: string | undefined,
      listener: Parameters<TermLoopClient["subscribeSurface"]>[2],
      format?: SurfaceFormat,
      historyLines?: number
    ): Promise<SurfaceSubscription> =>
      withReconnect(session, (client) =>
        client.subscribeSurface(
          workspaceId,
          surfaceId,
          listener,
          format,
          historyLines
        )
      ),
    resize: (params: { workspaceId: string; cols: number; rows: number }) =>
      withReconnect(session, (client) => client.resize(params)),
    close: async () => {
      if (active === session) {
        await closeSession();
      } else {
        session.closed = true;
        await session.current.client.close().catch(() => {});
      }
    },
  };
}

async function withReconnect<T>(
  session: ActiveSession,
  operation: (client: TermLoopClient) => Promise<T>,
  retryMode: "always" | "prewrite" = "always"
): Promise<T> {
  if (session.closed || active !== session) {
    throw new Error("Session is closed.");
  }

  const client = session.current.client;
  try {
    return await operation(client);
  } catch (err) {
    if (!shouldReconnect(err) || session.closed || active !== session) {
      throw err;
    }
    if (session.current.client === client) {
      await reconnectSession(session);
    } else if (session.reconnectPromise) {
      await session.reconnectPromise;
    }
    if (session.closed || active !== session) {
      throw new Error("Session is closed.");
    }
    if (retryMode === "prewrite" && !isPrewriteReconnectError(err)) {
      throw err;
    }
    return operation(session.current.client);
  }
}

async function reconnectSession(session: ActiveSession): Promise<void> {
  if (session.reconnectPromise) return session.reconnectPromise;
  session.reconnectPromise = (async () => {
    const previous = session.current;
    await previous.client.close().catch(() => {});
    if (session.closed || active !== session) {
      throw new Error("Session is closed.");
    }

    const next = await connectSavedConnection(session.conn);
    if (session.closed || active !== session) {
      await next.client.close().catch(() => {});
      throw new Error("Session is closed.");
    }
    session.current = next;
    session.auth = next.auth;
  })();

  try {
    await session.reconnectPromise;
  } finally {
    session.reconnectPromise = null;
  }
}

function shouldReconnect(err: unknown): boolean {
  if (err instanceof RpcCallError) {
    return (
      err.code === "unauthorized" ||
      err.code === "auth_required" ||
      err.code === "not_authenticated"
    );
  }

  const message = String((err as Error)?.message ?? err).toLowerCase();
  return (
    message.includes("socket not found") ||
    message.includes("socket not available") ||
    message.includes("transport is closed") ||
    message.includes("transport closed") ||
    message.includes("connection closed") ||
    message.includes("broken pipe") ||
    message.includes("econnreset") ||
    message.includes("econnaborted") ||
    message.includes("enotconn") ||
    message.includes("not connected")
  );
}

function isPrewriteReconnectError(err: unknown): boolean {
  if (err instanceof RpcCallError) {
    return shouldReconnect(err);
  }

  const message = String((err as Error)?.message ?? err).toLowerCase();
  return (
    message.includes("socket not found") ||
    message.includes("socket not available") ||
    message.includes("transport is closed")
  );
}

async function registerPushToken(client: TermLoopClient): Promise<void> {
  if (Platform.OS !== "ios") return;

  const permissions = await Notifications.getPermissionsAsync();
  let granted = permissions.granted || permissions.status === "granted";
  if (!granted && permissions.canAskAgain) {
    const next = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    granted = next.granted || next.status === "granted";
  }
  if (!granted) return;

  const token = await Notifications.getDevicePushTokenAsync();
  if (token.type !== "ios" || typeof token.data !== "string" || !token.data) {
    return;
  }

  await client.registerPushToken({
    deviceToken: token.data,
    platform: "ios",
    environment: __DEV__ ? "development" : "production",
  });
}

export function getActiveClient(): TermLoopClient | null {
  return active?.client ?? null;
}

export function getActiveAuth(): AuthResult | null {
  return active?.auth ?? null;
}

export function getActiveConnectionId(): string | null {
  return active?.connectionId ?? null;
}

export async function closeSession(): Promise<void> {
  if (!active) return;
  const a = active;
  active = null;
  a.closed = true;
  try {
    await a.current.client.close();
  } catch {
    /* ignore */
  }
}
