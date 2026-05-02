import { connectionHostCandidates, type SavedConnection } from "./connections";
import { TcpTransport } from "./tcp-transport";
import {
  createTermLoopClient,
  type AuthResult,
  type TermLoopClient,
  type Transport,
} from "./termloop-client";

interface ActiveSession {
  connectionId: string;
  client: TermLoopClient;
  transport: Transport;
  auth?: AuthResult;
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
  const hosts = connectionHostCandidates(conn);
  let lastErr: unknown = null;

  for (const host of hosts) {
    const transport: Transport = new TcpTransport({
      host,
      port: conn.port,
      connectTimeoutMs: hosts.length > 1 ? 3500 : undefined,
    });
    const client = createTermLoopClient({ transport });

    try {
      const { auth } = await applyAuth(client, conn);
      active = { connectionId: conn.id, client, transport, auth };
      return { client, auth };
    } catch (err) {
      lastErr = err;
      await client.close().catch(() => {});
    }
  }

  throw lastErr ?? new Error("Connection failed.");
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
  try {
    await a.client.close();
  } catch {
    /* ignore */
  }
}
