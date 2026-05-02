import type { SavedConnection } from "./connections";
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
  const transport: Transport = new TcpTransport({
    host: conn.host,
    port: conn.port,
  });
  const client = createTermLoopClient({ transport });

  let auth: AuthResult | undefined;
  try {
    ({ auth } = await applyAuth(client, conn));
  } catch (err) {
    await client.close();
    throw err;
  }

  active = { connectionId: conn.id, client, transport, auth };
  return { client, auth };
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
