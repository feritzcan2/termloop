import * as OwnedSessions from '../lib/owned-claude-sessions';

beforeEach(() => {
  OwnedSessions.releaseAll();
});

describe('owned-claude-sessions', () => {
  test('claim marks workspace as owned', () => {
    expect(OwnedSessions.isOwned('w1')).toBe(false);
    OwnedSessions.claim('w1', 'sid-1');
    expect(OwnedSessions.isOwned('w1')).toBe(true);
    expect(OwnedSessions.getOwned('w1')?.sessionId).toBe('sid-1');
  });

  test('release removes the claim', () => {
    OwnedSessions.claim('w1', 'sid-1');
    OwnedSessions.release('w1');
    expect(OwnedSessions.isOwned('w1')).toBe(false);
  });

  test('claims are independent per workspace', () => {
    OwnedSessions.claim('w1', 'sid-1');
    OwnedSessions.claim('w2', 'sid-2');
    OwnedSessions.release('w1');
    expect(OwnedSessions.isOwned('w1')).toBe(false);
    expect(OwnedSessions.isOwned('w2')).toBe(true);
  });

  test('releaseAll drops everything', () => {
    OwnedSessions.claim('w1', 'sid-1');
    OwnedSessions.claim('w2', 'sid-2');
    OwnedSessions.releaseAll();
    expect(OwnedSessions.isOwned('w1')).toBe(false);
    expect(OwnedSessions.isOwned('w2')).toBe(false);
  });

  test('replaceAll swaps the owned workspace set atomically', () => {
    OwnedSessions.claim('w1', 'sid-1');
    OwnedSessions.claim('w2', 'sid-2');

    OwnedSessions.replaceAll([
      { workspaceId: 'w2', sessionId: 'sid-2b' },
      { workspaceId: 'w3', sessionId: 'sid-3' },
    ]);

    expect(OwnedSessions.isOwned('w1')).toBe(false);
    expect(OwnedSessions.getOwned('w2')?.sessionId).toBe('sid-2b');
    expect(OwnedSessions.getOwned('w3')?.sessionId).toBe('sid-3');
  });

  test('subscribers fire on claim and release', () => {
    const calls: number[] = [];
    const unsub = OwnedSessions.subscribe(() => calls.push(Date.now()));
    OwnedSessions.claim('w1', 'sid-1');
    OwnedSessions.release('w1');
    unsub();
    OwnedSessions.claim('w2', 'sid-2'); // ignored
    expect(calls).toHaveLength(2);
  });

  test('release on unknown workspace is a no-op and does not emit', () => {
    const cb = jest.fn();
    const unsub = OwnedSessions.subscribe(cb);
    OwnedSessions.release('ghost');
    unsub();
    expect(cb).not.toHaveBeenCalled();
  });

  test('replaceAll with identical claims is a no-op', () => {
    const cb = jest.fn();
    OwnedSessions.claim('w1', 'sid-1');
    const unsub = OwnedSessions.subscribe(cb);
    OwnedSessions.replaceAll([{ workspaceId: 'w1', sessionId: 'sid-1' }]);
    unsub();
    expect(cb).not.toHaveBeenCalled();
  });
});
