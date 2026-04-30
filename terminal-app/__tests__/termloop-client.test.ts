type MessageListener = (event: { sessionId: string; line: string }) => void;
type DisconnectListener = (event: { sessionId: string; error?: string }) => void;

const mockState: {
  sessionCounter: number;
  connect: jest.Mock;
  send: jest.Mock;
  disconnect: jest.Mock;
  messageListeners: MessageListener[];
  disconnectListeners: DisconnectListener[];
} = {
  sessionCounter: 0,
  connect: jest.fn(),
  send: jest.fn(),
  disconnect: jest.fn(),
  messageListeners: [],
  disconnectListeners: [],
};

jest.mock('../modules/expo-termloop', () => ({
  connect: (...args: unknown[]) => mockState.connect(...args),
  send: (...args: unknown[]) => mockState.send(...args),
  disconnect: (...args: unknown[]) => mockState.disconnect(...args),
  onMessage: (cb: MessageListener) => {
    mockState.messageListeners.push(cb);
    return {
      remove: () => {
        mockState.messageListeners = mockState.messageListeners.filter((l) => l !== cb);
      },
    };
  },
  onState: () => ({ remove: () => {} }),
  onDisconnect: (cb: DisconnectListener) => {
    mockState.disconnectListeners.push(cb);
    return {
      remove: () => {
        mockState.disconnectListeners = mockState.disconnectListeners.filter((l) => l !== cb);
      },
    };
  },
}));

import { TermLoopClient, TermLoopClientState, TermLoopRpcError } from '../lib/termloop-client';

function emitLine(sessionId: string, obj: unknown) {
  const line = JSON.stringify(obj);
  for (const cb of [...mockState.messageListeners]) {
    cb({ sessionId, line });
  }
}

function captureSends(): any[] {
  return mockState.send.mock.calls.map(([, line]) => JSON.parse(line as string));
}

beforeEach(() => {
  mockState.sessionCounter = 0;
  mockState.connect.mockReset();
  mockState.send.mockReset();
  mockState.disconnect.mockReset();
  mockState.messageListeners = [];
  mockState.disconnectListeners = [];
});

describe('TermLoopClient', () => {
  test('connect sends auth.login and transitions to ready', async () => {
    const sessionId = 'session-1';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const states: TermLoopClientState[] = [];
    client.onStateChange((s) => states.push(s));

    const connectPromise = client.connect('127.0.0.1', 7878, 'secret');

    // wait a microtask so the send is registered
    await Promise.resolve();
    await Promise.resolve();

    const sends = captureSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].method).toBe('auth.login');
    expect(sends[0].params).toEqual({ password: 'secret' });

    emitLine(sessionId, { ok: true, result: { authenticated: true }, id: sends[0].id });

    await connectPromise;

    expect(states).toEqual(['connecting', 'authenticating', 'ready']);
    expect(client.currentState).toBe('ready');
  });

  test('id correlation resolves out-of-order responses', async () => {
    const sessionId = 'session-oo';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const connectPromise = client.connect('host', 1, 'pw');
    await Promise.resolve();
    await Promise.resolve();
    const authId = captureSends()[0].id;
    emitLine(sessionId, { ok: true, result: {}, id: authId });
    await connectPromise;

    mockState.send.mockClear();

    const p1 = client.listProjects();
    const p2 = client.listWorkspaces();
    await Promise.resolve();
    await Promise.resolve();

    const sends = captureSends();
    expect(sends.map((s) => s.method)).toEqual(['project.list', 'workspace.list']);

    // respond workspace.list FIRST (out of order)
    emitLine(sessionId, {
      ok: true,
      result: { workspaces: [{ id: 'w1' }] },
      id: sends[1].id,
    });
    emitLine(sessionId, {
      ok: true,
      result: { projects: [], active_project_id: null, open_project_ids: [] },
      id: sends[0].id,
    });

    const [projects, workspaces] = await Promise.all([p1, p2]);
    expect(projects.projects).toEqual([]);
    expect(workspaces.workspaces).toEqual([{ id: 'w1' }]);
  });

  test('rejects with TermLoopRpcError on ok:false', async () => {
    const sessionId = 'session-err';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const bad = client.connect('host', 1, 'wrong');
    await Promise.resolve();
    await Promise.resolve();
    const authId = captureSends()[0].id;

    emitLine(sessionId, {
      ok: false,
      error: { code: 'auth_failed', message: 'bad password' },
      id: authId,
    });

    await expect(bad).rejects.toBeInstanceOf(TermLoopRpcError);
    expect(client.currentState).toBe('error');
  });

  test('disconnect event fails pending requests', async () => {
    const sessionId = 'session-d';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const connectPromise = client.connect('host', 1, 'pw');
    await Promise.resolve();
    await Promise.resolve();
    const authId = captureSends()[0].id;
    emitLine(sessionId, { ok: true, result: {}, id: authId });
    await connectPromise;

    const pending = client.listProjects();
    await Promise.resolve();
    await Promise.resolve();

    for (const cb of [...mockState.disconnectListeners]) {
      cb({ sessionId, error: 'boom' });
    }

    await expect(pending).rejects.toThrow(/boom|connection closed/);
    expect(client.currentState).toBe('disconnected');
  });

  test('malformed lines are ignored', async () => {
    const sessionId = 'session-m';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const connectPromise = client.connect('host', 1, 'pw');
    await Promise.resolve();
    await Promise.resolve();
    const authId = captureSends()[0].id;

    // emit garbage before valid response
    for (const cb of [...mockState.messageListeners]) {
      cb({ sessionId, line: 'not json' });
      cb({ sessionId, line: '{"no":"id"}' });
      cb({ sessionId, line: JSON.stringify({ ok: true, result: {}, id: 9999 }) });
    }

    emitLine(sessionId, { ok: true, result: {}, id: authId });
    await expect(connectPromise).resolves.toBeUndefined();
  });

  test('listWorkspaces parses claude_session_id and claude_cwd when present', async () => {
    const sessionId = 'session-claude';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const conn = client.connect('h', 1, 'pw');
    await Promise.resolve(); await Promise.resolve();
    const authId = captureSends()[0].id;
    emitLine(sessionId, { ok: true, result: {}, id: authId });
    await conn;

    mockState.send.mockClear();
    const p = client.listWorkspaces();
    await Promise.resolve(); await Promise.resolve();
    const listId = captureSends()[0].id;
    emitLine(sessionId, {
      ok: true,
      id: listId,
      result: {
        workspaces: [
          { id: 'w1', title: 'trunk', project_id: 'p1', claude_session_id: 'sess-abc', claude_cwd: '/tmp/x' },
          { id: 'w2', title: 'idle', project_id: null, claude_session_id: null, claude_cwd: null },
        ],
      },
    });

    const result = await p;
    expect(result.workspaces[0].claude_session_id).toBe('sess-abc');
    expect(result.workspaces[0].claude_cwd).toBe('/tmp/x');
    expect(result.workspaces[1].claude_session_id).toBeNull();
    expect(result.workspaces[1].claude_cwd).toBeNull();
  });

  test('listWorkspaces tolerates older servers that omit the new fields', async () => {
    const sessionId = 'session-old';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const conn = client.connect('h', 1, 'pw');
    await Promise.resolve(); await Promise.resolve();
    const authId = captureSends()[0].id;
    emitLine(sessionId, { ok: true, result: {}, id: authId });
    await conn;

    mockState.send.mockClear();
    const p = client.listWorkspaces();
    await Promise.resolve(); await Promise.resolve();
    const listId = captureSends()[0].id;
    emitLine(sessionId, {
      ok: true, id: listId,
      result: { workspaces: [{ id: 'w1', title: 't', project_id: null }] },
    });

    const result = await p;
    expect(result.workspaces[0].claude_session_id).toBeUndefined();
    expect(result.workspaces[0].claude_cwd).toBeUndefined();
  });

  test('killClaudeSession sends correct method + params and parses killed result', async () => {
    const sessionId = 'session-kill';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const conn = client.connect('h', 1, 'pw');
    await Promise.resolve(); await Promise.resolve();
    const authId = captureSends()[0].id;
    emitLine(sessionId, { ok: true, result: {}, id: authId });
    await conn;

    mockState.send.mockClear();
    const killPromise = client.killClaudeSession('ws-1');
    await Promise.resolve(); await Promise.resolve();
    const sends = captureSends();
    expect(sends[0].method).toBe('workspace.kill_claude_session');
    expect(sends[0].params).toEqual({ workspace_id: 'ws-1' });

    emitLine(sessionId, {
      ok: true, id: sends[0].id,
      result: { killed: true, pid: 12345, session_id: 'sid' },
    });

    const r = await killPromise;
    expect(r.killed).toBe(true);
    expect(r.pid).toBe(12345);
    expect(r.session_id).toBe('sid');
  });

  test('killClaudeSession passes force flag when requested', async () => {
    const sessionId = 'session-kill-force';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const conn = client.connect('h', 1, 'pw');
    await Promise.resolve(); await Promise.resolve();
    emitLine(sessionId, { ok: true, result: {}, id: captureSends()[0].id });
    await conn;

    mockState.send.mockClear();
    const p = client.killClaudeSession('ws-2', { force: true });
    await Promise.resolve(); await Promise.resolve();
    const sends = captureSends();
    expect(sends[0].params).toEqual({ workspace_id: 'ws-2', force: true });
    emitLine(sessionId, { ok: true, id: sends[0].id, result: { killed: true, pid: 9, session_id: 's' } });
    await p;
  });

  test('killClaudeSession parses no_session / no_pid refusal', async () => {
    const sessionId = 'session-kill-none';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const conn = client.connect('h', 1, 'pw');
    await Promise.resolve(); await Promise.resolve();
    emitLine(sessionId, { ok: true, result: {}, id: captureSends()[0].id });
    await conn;

    mockState.send.mockClear();
    const p = client.killClaudeSession('ws-3');
    await Promise.resolve(); await Promise.resolve();
    const sendId = captureSends()[0].id;
    emitLine(sessionId, { ok: true, id: sendId, result: { killed: false, reason: 'no_pid' } });
    const r = await p;
    expect(r.killed).toBe(false);
    expect(r.reason).toBe('no_pid');
  });

  test('spawnClaudeInWorkspace sends correct method + params with cwd', async () => {
    const sessionId = 'session-spawn';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const conn = client.connect('h', 1, 'pw');
    await Promise.resolve(); await Promise.resolve();
    emitLine(sessionId, { ok: true, result: {}, id: captureSends()[0].id });
    await conn;

    mockState.send.mockClear();
    const p = client.spawnClaudeInWorkspace('ws-x', 'sid-x', '/repo');
    await Promise.resolve(); await Promise.resolve();
    const sends = captureSends();
    expect(sends[0].method).toBe('workspace.spawn_claude_session');
    expect(sends[0].params).toEqual({
      workspace_id: 'ws-x',
      session_id: 'sid-x',
      cwd: '/repo',
    });
    emitLine(sessionId, {
      ok: true, id: sends[0].id,
      result: { spawned: true, workspace_id: 'ws-x', session_id: 'sid-x', surface_id: 'sfc' },
    });
    const r = await p;
    expect(r.spawned).toBe(true);
    expect(r.surface_id).toBe('sfc');
  });

  test('prepareClaudeResume sends correct method + params and parses cwd', async () => {
    const sessionId = 'session-prepare';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const conn = client.connect('h', 1, 'pw');
    await Promise.resolve(); await Promise.resolve();
    emitLine(sessionId, { ok: true, result: {}, id: captureSends()[0].id });
    await conn;

    mockState.send.mockClear();
    const p = client.prepareClaudeResume('ws-prep', 'sid-prep', {
      cwd: '/repo/.termloop-worktrees/feature',
      sourceCwd: '/repo',
    });
    await Promise.resolve(); await Promise.resolve();
    const sends = captureSends();
    expect(sends[0].method).toBe('workspace.prepare_claude_resume');
    expect(sends[0].params).toEqual({
      workspace_id: 'ws-prep',
      session_id: 'sid-prep',
      cwd: '/repo/.termloop-worktrees/feature',
      source_cwd: '/repo',
    });
    emitLine(sessionId, {
      ok: true, id: sends[0].id,
      result: {
        prepared: true,
        workspace_id: 'ws-prep',
        session_id: 'sid-prep',
        cwd: '/repo/.termloop-worktrees/feature',
      },
    });
    const r = await p;
    expect(r.prepared).toBe(true);
    expect(r.cwd).toBe('/repo/.termloop-worktrees/feature');
  });

  test('parses claude_running and claude_hooks_installed from workspace.list', async () => {
    const sessionId = 'session-cr';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const conn = client.connect('h', 1, 'pw');
    await Promise.resolve(); await Promise.resolve();
    emitLine(sessionId, { ok: true, result: {}, id: captureSends()[0].id });
    await conn;

    mockState.send.mockClear();
    const p = client.listWorkspaces();
    await Promise.resolve(); await Promise.resolve();
    const id = captureSends()[0].id;
    emitLine(sessionId, {
      ok: true, id,
      result: {
        workspaces: [
          { id: 'w1', title: 't1', project_id: null, claude_session_id: 's1', claude_running: false, claude_hooks_installed: true },
          { id: 'w2', title: 't2', project_id: null, claude_session_id: 's2', claude_running: true, claude_hooks_installed: true },
          { id: 'w3', title: 't3', project_id: null, claude_running: null, claude_hooks_installed: false },
        ],
      },
    });
    const r = await p;
    expect(r.workspaces[0].claude_running).toBe(false);
    expect(r.workspaces[1].claude_running).toBe(true);
    expect(r.workspaces[2].claude_running).toBeNull();
    expect(r.workspaces[0].claude_hooks_installed).toBe(true);
    expect(r.workspaces[2].claude_hooks_installed).toBe(false);
  });

  test('pushRegister sends correct method + params', async () => {
    const sessionId = 'session-push';
    mockState.connect.mockResolvedValue(sessionId);
    mockState.send.mockResolvedValue(undefined);

    const client = new TermLoopClient();
    const conn = client.connect('h', 1, 'pw');
    await Promise.resolve(); await Promise.resolve();
    emitLine(sessionId, { ok: true, result: {}, id: captureSends()[0].id });
    await conn;

    mockState.send.mockClear();
    const p = client.pushRegister('dev-token-abc', 'ios', 'development');
    await Promise.resolve(); await Promise.resolve();
    const sends = captureSends();
    expect(sends[0].method).toBe('push.register');
    expect(sends[0].params).toEqual({
      device_token: 'dev-token-abc',
      platform: 'ios',
      environment: 'development',
    });

    emitLine(sessionId, { ok: true, id: sends[0].id, result: { registered: true } });
    const r = await p;
    expect(r.registered).toBe(true);
  });
});
