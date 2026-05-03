import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
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
      void registerPushToken(client).catch((err) => {
        console.warn("Push registration skipped:", err);
      });
      return { client, auth };
    } catch (err) {
      lastErr = err;
      await client.close().catch(() => {});
    }
  }

  throw lastErr ?? new Error("Connection failed.");
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
  try {
    await a.client.close();
  } catch {
    /* ignore */
  }
}
