import AsyncStorage from '@react-native-async-storage/async-storage';
import { createNewConnection, saveConnection } from '../lib/connections';
import {
  clearTerminalResumeRoutes,
  getRestorableTerminalResumeRoutes,
  getTerminalResumeRoutes,
  removeTerminalResumeRoute,
  upsertTerminalResumeRoute,
} from '../lib/terminal-resume-route';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('terminal-resume-route', () => {
  test('upsert -> get round-trips resumable terminal routes in stack order', async () => {
    await upsertTerminalResumeRoute({
      instanceId: 'inst-1',
      id: 'conn-1',
      cwd: '/repo',
      resume: 'sess-1',
      workspaceId: 'ws-1',
    });
    await upsertTerminalResumeRoute({
      instanceId: 'inst-2',
      id: 'conn-2',
      resume: 'sess-2',
    });

    const routes = await getTerminalResumeRoutes();
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      instanceId: 'inst-1',
      id: 'conn-1',
      cwd: '/repo',
      resume: 'sess-1',
      workspaceId: 'ws-1',
    });
    expect(routes[1]).toMatchObject({
      instanceId: 'inst-2',
      id: 'conn-2',
      resume: 'sess-2',
    });
    expect(typeof routes[0]?.savedAt).toBe('number');
  });

  test('remove deletes only the matching terminal instance', async () => {
    await upsertTerminalResumeRoute({
      instanceId: 'inst-1',
      id: 'conn-1',
      resume: 'sess-1',
    });
    await upsertTerminalResumeRoute({
      instanceId: 'inst-2',
      id: 'conn-2',
      resume: 'sess-2',
    });

    await removeTerminalResumeRoute('inst-1');
    expect(await getTerminalResumeRoutes()).toMatchObject([
      { instanceId: 'inst-2', id: 'conn-2', resume: 'sess-2' },
    ]);
  });

  test('clear removes the whole persisted stack', async () => {
    await upsertTerminalResumeRoute({
      instanceId: 'inst-1',
      id: 'conn-1',
      resume: 'sess-1',
    });

    await clearTerminalResumeRoutes();
    expect(await getTerminalResumeRoutes()).toEqual([]);
  });

  test('invalid stored payload is dropped', async () => {
    await AsyncStorage.setItem('terminal_resume_route', JSON.stringify({ nope: true }));

    expect(await getTerminalResumeRoutes()).toEqual([]);
    expect(await AsyncStorage.getItem('terminal_resume_route')).toBeNull();
  });

  test('upsert on an existing instance moves it to the top', async () => {
    await upsertTerminalResumeRoute({
      instanceId: 'inst-1',
      id: 'conn-1',
      resume: 'sess-1',
    });
    await upsertTerminalResumeRoute({
      instanceId: 'inst-2',
      id: 'conn-2',
      resume: 'sess-2',
    });

    await upsertTerminalResumeRoute({
      instanceId: 'inst-1',
      id: 'conn-1',
      resume: 'sess-1',
      cwd: '/repo',
    });

    expect(await getTerminalResumeRoutes()).toMatchObject([
      { instanceId: 'inst-2', id: 'conn-2', resume: 'sess-2' },
      { instanceId: 'inst-1', id: 'conn-1', resume: 'sess-1', cwd: '/repo' },
    ]);
  });

  test('restorable routes require existing connections', async () => {
    const conn = createNewConnection();
    conn.id = 'conn-1';
    conn.host = 'mac.local';
    conn.ssh.user = 'feri';
    await saveConnection(conn);

    await upsertTerminalResumeRoute({
      instanceId: 'inst-1',
      id: conn.id,
      resume: 'sess-1',
      cwd: '/repo',
    });
    await upsertTerminalResumeRoute({
      instanceId: 'inst-2',
      id: 'ghost-conn',
      resume: 'sess-2',
    });

    expect(await getRestorableTerminalResumeRoutes()).toMatchObject([
      { instanceId: 'inst-1', id: conn.id, resume: 'sess-1', cwd: '/repo' },
    ]);
    expect(await getTerminalResumeRoutes()).toMatchObject([
      { instanceId: 'inst-1', id: conn.id, resume: 'sess-1', cwd: '/repo' },
    ]);
  });
});
