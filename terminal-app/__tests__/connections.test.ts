import AsyncStorage from '@react-native-async-storage/async-storage';

const mockStore: Record<string, string> = {};
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => (k in mockStore ? mockStore[k] : null)),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore[k] = v; }),
  deleteItemAsync: jest.fn(async (k: string) => { delete mockStore[k]; }),
}));

import {
  getConnections,
  getConnection,
  saveConnection,
  deleteConnection,
  createNewConnection,
} from '../lib/connections';

const STORAGE_KEY = 'terminal_connections';

beforeEach(async () => {
  await AsyncStorage.clear();
  for (const k of Object.keys(mockStore)) delete mockStore[k];
});

describe('Connection storage', () => {
  test('createNewConnection returns the unified shape', () => {
    const c = createNewConnection();
    expect(c.id).toBeTruthy();
    expect(c.ssh.port).toBe(22);
    expect(c.termloop.port).toBe(7878);
    expect(c.ssh.user).toBe('');
    expect(c.label).toBe('');
    expect(c.lastConnected).toBeNull();
    expect(c.incomplete).toBeFalsy();
  });

  test('save -> list round-trips a complete connection', async () => {
    const c = createNewConnection();
    c.label = 'Mac';
    c.host = '100.64.0.1';
    c.ssh.user = 'feri';
    await saveConnection(c);

    const all = await getConnections();
    expect(all).toHaveLength(1);
    expect(all[0].host).toBe('100.64.0.1');
    expect(all[0].ssh.user).toBe('feri');
  });

  test('legacy ssh row is promoted to incomplete Connection', async () => {
    const legacy = [{
      kind: 'ssh',
      id: 'legacy-ssh',
      label: 'Old SSH',
      host: 'example.com',
      port: 2222,
      username: 'root',
      authType: 'password',
      theme: 'nord',
      lastConnected: 1700000000,
    }];
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));

    const all = await getConnections();
    expect(all).toHaveLength(1);
    const c = all[0];
    expect(c.id).toBe('legacy-ssh');
    expect(c.label).toBe('Old SSH');
    expect(c.host).toBe('example.com');
    expect(c.ssh.port).toBe(2222);
    expect(c.ssh.user).toBe('root');
    expect(c.termloop.port).toBe(7878);
    expect(c.theme).toBe('nord');
    expect(c.lastConnected).toBe(1700000000);
    expect(c.incomplete).toBe(true);
  });

  test('legacy termloop row is promoted and termloop_token_<id> renames to termloop_pw_<id>', async () => {
    mockStore['termloop_token_legacy-termloop'] = 'oldpass';
    const legacy = [{
      kind: 'termloop',
      id: 'legacy-termloop',
      label: 'Old termloop',
      host: 'mac.local',
      port: 7878,
      lastConnected: null,
    }];
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));

    const all = await getConnections();
    expect(all).toHaveLength(1);
    const c = all[0];
    expect(c.id).toBe('legacy-termloop');
    expect(c.host).toBe('mac.local');
    expect(c.termloop.port).toBe(7878);
    expect(c.ssh.port).toBe(22);
    expect(c.ssh.user).toBe('');
    expect(c.incomplete).toBe(true);

    expect(mockStore['termloop_token_legacy-termloop']).toBeUndefined();
    expect(mockStore['termloop_pw_legacy-termloop']).toBe('oldpass');
  });

  test('migration is idempotent — second load does not re-promote', async () => {
    const legacy = [{ kind: 'ssh', id: 'a', label: 'a', host: 'h', port: 22, username: 'u', authType: 'password', theme: 'dracula', lastConnected: null }];
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));

    await getConnections();
    const after = await AsyncStorage.getItem(STORAGE_KEY);
    expect(after).toBeTruthy();
    const parsed = JSON.parse(after!);
    expect(parsed[0].kind).toBeUndefined();
    expect(parsed[0].ssh).toBeDefined();
  });

  test('deleteConnection removes the row', async () => {
    const c = createNewConnection();
    c.host = 'h'; c.ssh.user = 'u';
    await saveConnection(c);
    await deleteConnection(c.id);
    expect(await getConnections()).toHaveLength(0);
  });

  test('getConnection returns null for unknown id', async () => {
    expect(await getConnection('nope')).toBeNull();
  });
});
