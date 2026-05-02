// Last opened terminal per saved connection. Pure metadata in AsyncStorage,
// keyed by connectionId, used to resume the most recent terminal directly
// when a user reconnects.

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { TermLoopClient } from "./termloop-client";

const KEY = "termloop.last_terminal.v1";

export interface LastTerminal {
  connectionId: string;
  workspaceId: string;
  surfaceId: string;
  workspaceName: string;
  surfaceName: string;
  /** ISO timestamp. */
  updatedAt: string;
}

type Cache = Record<string, LastTerminal>;

let cache: Cache | null = null;

async function load(): Promise<Cache> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as Cache) : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(next: Cache): Promise<void> {
  cache = next;
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
}

export async function saveLastTerminal(
  entry: Omit<LastTerminal, "updatedAt">
): Promise<void> {
  const map = await load();
  await persist({
    ...map,
    [entry.connectionId]: { ...entry, updatedAt: new Date().toISOString() },
  });
}

export async function getLastTerminal(
  connectionId: string
): Promise<LastTerminal | null> {
  const map = await load();
  return map[connectionId] ?? null;
}

export async function clearLastTerminal(connectionId: string): Promise<void> {
  const map = await load();
  if (!(connectionId in map)) return;
  const next = { ...map };
  delete next[connectionId];
  await persist(next);
}

/** Returns true when the saved surface still exists on the server. */
export async function validateLastTerminal(
  client: TermLoopClient,
  last: Pick<LastTerminal, "workspaceId" | "surfaceId">
): Promise<boolean> {
  try {
    const surfaces = await client.listSurfaces(last.workspaceId);
    return surfaces.some((s) => s.id === last.surfaceId);
  } catch {
    return false;
  }
}
