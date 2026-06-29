// Saved connections — non-sensitive metadata in AsyncStorage, secrets
// (accessToken / password) in expo-secure-store. The split is deliberate:
// AsyncStorage is plaintext and survives backups, SecureStore is hardware-
// backed (Keychain on iOS, EncryptedSharedPreferences on Android).

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { clearVoiceAgentConnection } from "./voice-agent-config";

const META_KEY_V2 = "termloop.connections.v2";
const LEGACY_KEY_V1 = "termloop.connections.v1";

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  alternateHosts?: string[];
  port: number;
  deviceId?: string;
  serverName?: string;
  lastConnectedAt?: string;
  /** Hydrated from SecureStore on read; never persisted to AsyncStorage. */
  accessToken?: string;
  /** Hydrated from SecureStore on read; never persisted to AsyncStorage. */
  password?: string;
}

export type ConnectionMetadata = Omit<SavedConnection, "accessToken" | "password">;

let cache: ConnectionMetadata[] | null = null;
let migrated = false;

const accessTokenSecretKey = (id: string) =>
  `termloop.access_token.${sanitizeId(id)}`;
const passwordSecretKey = (id: string) =>
  `termloop.password.${sanitizeId(id)}`;

// SecureStore keys must be alphanumeric / `.` / `-` / `_`. Connection IDs
// are generated to match that, but be defensive against legacy IDs.
function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function readSecret(key: string): Promise<string | undefined> {
  try {
    const v = await SecureStore.getItemAsync(key);
    return v ?? undefined;
  } catch {
    return undefined;
  }
}

async function writeSecret(key: string, value: string | undefined): Promise<void> {
  if (value === undefined || value === "") {
    await SecureStore.deleteItemAsync(key).catch(() => {});
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function migrateLegacyIfNeeded(): Promise<ConnectionMetadata[] | null> {
  const raw = await AsyncStorage.getItem(LEGACY_KEY_V1).catch(() => null);
  if (!raw) return null;
  let legacy: Array<SavedConnection & Record<string, unknown>>;
  try {
    legacy = JSON.parse(raw);
  } catch {
    await AsyncStorage.removeItem(LEGACY_KEY_V1).catch(() => {});
    return null;
  }

  const meta: ConnectionMetadata[] = [];
  for (const rec of legacy) {
    if (!rec || !rec.id) continue;
    const { accessToken, password, ...rest } = rec;
    if (typeof accessToken === "string" && accessToken) {
      await writeSecret(accessTokenSecretKey(rec.id), accessToken).catch(() => {});
    }
    if (typeof password === "string" && password) {
      await writeSecret(passwordSecretKey(rec.id), password).catch(() => {});
    }
    meta.push(stripSecrets(rest as SavedConnection));
  }

  await AsyncStorage.setItem(META_KEY_V2, JSON.stringify(meta));
  await AsyncStorage.removeItem(LEGACY_KEY_V1).catch(() => {});
  return meta;
}

function stripSecrets(c: SavedConnection): ConnectionMetadata {
  const { accessToken: _a, password: _p, ...rest } = c;
  return normalizeConnectionMetadata(rest);
}

function normalizeHost(host: string | undefined): string | null {
  const value = host?.trim();
  return value ? value : null;
}

export function connectionHostCandidates(
  conn: Pick<SavedConnection, "host" | "alternateHosts">
): string[] {
  const out: string[] = [];
  for (const host of [conn.host, ...(conn.alternateHosts ?? [])]) {
    const normalized = normalizeHost(host);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function normalizeConnectionMetadata(
  c: ConnectionMetadata
): ConnectionMetadata {
  const host = normalizeHost(c.host) ?? c.host;
  const alternateHosts = connectionHostCandidates({
    host,
    alternateHosts: c.alternateHosts,
  }).filter((item) => item !== host);
  return {
    ...c,
    host,
    ...(alternateHosts.length > 0 ? { alternateHosts } : { alternateHosts: undefined }),
  };
}

async function loadMetadata(): Promise<ConnectionMetadata[]> {
  if (cache) return cache;
  if (!migrated) {
    migrated = true;
    const fromLegacy = await migrateLegacyIfNeeded();
    if (fromLegacy) {
      cache = fromLegacy;
      return cache;
    }
  }
  try {
    const raw = await AsyncStorage.getItem(META_KEY_V2);
    cache = raw ? (JSON.parse(raw) as ConnectionMetadata[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persistMetadata(next: ConnectionMetadata[]): Promise<void> {
  cache = next;
  await AsyncStorage.setItem(META_KEY_V2, JSON.stringify(next));
}

async function hydrate(meta: ConnectionMetadata): Promise<SavedConnection> {
  const [accessToken, password] = await Promise.all([
    readSecret(accessTokenSecretKey(meta.id)),
    readSecret(passwordSecretKey(meta.id)),
  ]);
  return { ...meta, accessToken, password };
}

export async function listConnections(): Promise<SavedConnection[]> {
  const meta = await loadMetadata();
  return Promise.all(meta.map(hydrate));
}

export async function getConnection(
  id: string
): Promise<SavedConnection | undefined> {
  const meta = (await loadMetadata()).find((c) => c.id === id);
  if (!meta) return undefined;
  return hydrate(meta);
}

export async function findConnectionMetaByEndpoint(
  host: string,
  port: number,
  alternateHosts: string[] = []
): Promise<ConnectionMetadata | undefined> {
  const incoming = new Set(
    connectionHostCandidates({ host, alternateHosts })
  );
  return (await loadMetadata()).find((c) => {
    if (c.port !== port) return false;
    // Re-pair should update an existing saved Mac even if the QR advertises
    // a different reachable host. In the rare case of two Macs sharing a host
    // alias on the same port, the first saved match wins.
    return connectionHostCandidates(c).some((candidate) =>
      incoming.has(candidate)
    );
  });
}

export async function upsertConnection(
  input: Omit<SavedConnection, "id"> & { id?: string }
): Promise<SavedConnection> {
  const list = await loadMetadata();
  const id =
    input.id ?? `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await Promise.all([
    writeSecret(accessTokenSecretKey(id), input.accessToken),
    writeSecret(passwordSecretKey(id), input.password),
  ]);

  const metaRecord = stripSecrets({ ...input, id });
  const idx = list.findIndex((c) => c.id === id);
  const next =
    idx >= 0
      ? list.map((c, i) => (i === idx ? metaRecord : c))
      : [...list, metaRecord];
  await persistMetadata(next);
  return { ...metaRecord, accessToken: input.accessToken, password: input.password };
}

export async function deleteConnection(id: string): Promise<void> {
  const list = await loadMetadata();
  await persistMetadata(list.filter((c) => c.id !== id));
  await Promise.all([
    SecureStore.deleteItemAsync(accessTokenSecretKey(id)).catch(() => {}),
    SecureStore.deleteItemAsync(passwordSecretKey(id)).catch(() => {}),
    clearVoiceAgentConnection(id).catch(() => {}),
  ]);
}

export async function clearConnectionSecrets(id: string): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(accessTokenSecretKey(id)).catch(() => {}),
    SecureStore.deleteItemAsync(passwordSecretKey(id)).catch(() => {}),
    clearVoiceAgentConnection(id).catch(() => {}),
  ]);
}

export async function markConnected(id: string): Promise<void> {
  const list = await loadMetadata();
  const next = list.map((c) =>
    c.id === id ? { ...c, lastConnectedAt: new Date().toISOString() } : c
  );
  await persistMetadata(next);
}

/**
 * True when the connection has paired metadata (deviceId) but the
 * SecureStore-backed token is gone, or has no auth at all. UI uses this
 * to surface a "Needs re-pairing" state.
 */
export function connectionNeedsReauth(conn: SavedConnection): boolean {
  if (conn.deviceId) return !conn.accessToken;
  return !conn.password;
}
