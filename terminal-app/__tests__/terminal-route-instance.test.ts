import {
  getTerminalRouteIdentity,
  makeTerminalInstanceId,
} from '../lib/terminal-route-instance';

describe('terminal-route-instance', () => {
  test('prefers an explicit instanceId when present', () => {
    expect(
      getTerminalRouteIdentity({
        id: 'conn-1',
        instanceId: 'inst-1',
        resume: 'sess-1',
      })
    ).toBe('inst-1');
  });

  test('falls back to resume context when instanceId is absent', () => {
    expect(
      getTerminalRouteIdentity({
        id: 'conn-1',
        resume: 'sess-1',
        cwd: '/repo',
        workspaceId: 'ws-1',
      })
    ).toBe('conn-1::sess-1::/repo::ws-1');
  });

  test('returns undefined for non-resumable shells', () => {
    expect(getTerminalRouteIdentity({ id: 'conn-1' })).toBeUndefined();
  });

  test('instance ids are non-empty', () => {
    expect(makeTerminalInstanceId()).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});

