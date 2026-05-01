// Tokens/passwords are stored in cleartext via AsyncStorage. Move to
// expo-secure-store before any non-developer build.

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "termloop.connections.v1";

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  /** Set after pairing — used with `auth.token`. */
  deviceId?: string;
  accessToken?: string;
  /** Manual-setup fallback — used with `auth.login`. */
  password?: string;
  serverName?: string;
  lastConnectedAt?: string;
}

let cache: SavedConnection[] | null = null;

async function load(): Promise<SavedConnection[]> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as SavedConnection[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(next: SavedConnection[]): Promise<void> {
  cache = next;
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
}

export async function listConnections(): Promise<SavedConnection[]> {
  return [...(await load())];
}

export async function getConnection(
  id: string
): Promise<SavedConnection | undefined> {
  return (await load()).find((c) => c.id === id);
}

export async function upsertConnection(
  input: Omit<SavedConnection, "id"> & { id?: string }
): Promise<SavedConnection> {
  const list = await load();
  const id =
    input.id ?? `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record: SavedConnection = { ...input, id };
  const idx = list.findIndex((c) => c.id === id);
  const next =
    idx >= 0 ? list.map((c, i) => (i === idx ? record : c)) : [...list, record];
  await persist(next);
  return record;
}

export async function deleteConnection(id: string): Promise<void> {
  const list = await load();
  await persist(list.filter((c) => c.id !== id));
}

export async function markConnected(id: string): Promise<void> {
  const list = await load();
  const next = list.map((c) =>
    c.id === id ? { ...c, lastConnectedAt: new Date().toISOString() } : c
  );
  await persist(next);
}
