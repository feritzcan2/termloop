// Last successful connection — id only, no secrets. Persisted so the
// app can reopen the most recently used connection on launch.

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "termloop.last_connection.v1";

interface Stored {
  connectionId: string;
  updatedAt: string;
}

export async function saveLastConnection(connectionId: string): Promise<void> {
  const v: Stored = { connectionId, updatedAt: new Date().toISOString() };
  await AsyncStorage.setItem(KEY, JSON.stringify(v));
}

export async function getLastConnection(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return typeof parsed.connectionId === "string" ? parsed.connectionId : null;
  } catch {
    return null;
  }
}

export async function clearLastConnection(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
