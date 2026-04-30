import AsyncStorage from '@react-native-async-storage/async-storage';
import { Connection } from './types';
import { renameLegacyTermLoopKey } from './secrets';

const STORAGE_KEY = 'terminal_connections';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export function createNewConnection(): Connection {
  return {
    id: generateId(),
    label: '',
    host: '',
    ssh: { port: 22, user: '' },
    termloop: { port: 7878 },
    theme: 'dracula',
    lastConnected: null,
  };
}

function promoteLegacySsh(row: any): Connection {
  return {
    id: String(row.id ?? generateId()),
    label: String(row.label ?? row.host ?? ''),
    host: String(row.host ?? ''),
    ssh: {
      port: typeof row.port === 'number' ? row.port : 22,
      user: String(row.username ?? ''),
    },
    termloop: { port: 7878 },
    theme: typeof row.theme === 'string' ? row.theme : 'dracula',
    lastConnected: typeof row.lastConnected === 'number' ? row.lastConnected : null,
    incomplete: true,
  };
}

function promoteLegacyTermLoop(row: any): Connection {
  return {
    id: String(row.id ?? generateId()),
    label: String(row.label ?? row.host ?? ''),
    host: String(row.host ?? ''),
    ssh: { port: 22, user: '' },
    termloop: { port: typeof row.port === 'number' ? row.port : 7878 },
    theme: 'dracula',
    lastConnected: typeof row.lastConnected === 'number' ? row.lastConnected : null,
    incomplete: true,
  };
}

function looksLikeUnifiedConnection(row: any): boolean {
  return (
    row && typeof row === 'object' &&
    row.kind === undefined &&
    row.ssh && typeof row.ssh === 'object' &&
    row.termloop && typeof row.termloop === 'object'
  );
}

export async function getConnections(): Promise<Connection[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const parsed: any[] = JSON.parse(raw);

  let migrated = false;
  const out: Connection[] = [];
  for (const row of parsed) {
    if (looksLikeUnifiedConnection(row)) {
      out.push(row as Connection);
      continue;
    }
    if (row?.kind === 'termloop') {
      out.push(promoteLegacyTermLoop(row));
      try { await renameLegacyTermLoopKey(String(row.id)); } catch {}
      migrated = true;
    } else {
      out.push(promoteLegacySsh(row));
      migrated = true;
    }
  }
  if (migrated) {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  }
  return out;
}

export async function getConnection(id: string): Promise<Connection | null> {
  const all = await getConnections();
  return all.find((c) => c.id === id) ?? null;
}

export async function saveConnection(conn: Connection): Promise<void> {
  const all = await getConnections();
  const idx = all.findIndex((c) => c.id === conn.id);
  if (idx >= 0) all[idx] = conn;
  else all.push(conn);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export async function deleteConnection(id: string): Promise<void> {
  const all = await getConnections();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(all.filter((c) => c.id !== id)));
}
