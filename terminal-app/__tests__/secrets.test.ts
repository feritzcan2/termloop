const mockStore: Record<string, string> = {};

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => (k in mockStore ? mockStore[k] : null)),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore[k] = v; }),
  deleteItemAsync: jest.fn(async (k: string) => { delete mockStore[k]; }),
}));

import {
  getTermLoopPassword,
  setTermLoopPassword,
  deleteTermLoopPassword,
  getSshPassword,
  setSshPassword,
  deleteSshPassword,
  renameLegacyTermLoopKey,
} from '../lib/secrets';

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
});

describe('secrets', () => {
  test('termloop password round-trips at termloop_pw_<id>', async () => {
    await setTermLoopPassword('abc', 'pw1');
    expect(mockStore['termloop_pw_abc']).toBe('pw1');
    expect(await getTermLoopPassword('abc')).toBe('pw1');
    await deleteTermLoopPassword('abc');
    expect(mockStore['termloop_pw_abc']).toBeUndefined();
  });

  test('ssh password round-trips at ssh_pw_<id>', async () => {
    await setSshPassword('abc', 'pw2');
    expect(mockStore['ssh_pw_abc']).toBe('pw2');
    expect(await getSshPassword('abc')).toBe('pw2');
    await deleteSshPassword('abc');
    expect(mockStore['ssh_pw_abc']).toBeUndefined();
  });

  test('renameLegacyTermLoopKey moves termloop_token_<id> to termloop_pw_<id>', async () => {
    mockStore['termloop_token_xyz'] = 'old';
    await renameLegacyTermLoopKey('xyz');
    expect(mockStore['termloop_token_xyz']).toBeUndefined();
    expect(mockStore['termloop_pw_xyz']).toBe('old');
  });

  test('renameLegacyTermLoopKey is a no-op when no legacy value exists', async () => {
    await renameLegacyTermLoopKey('nope');
    expect(mockStore['termloop_pw_nope']).toBeUndefined();
  });
});
