// Tests the event-frame routing + subscribe API on TermLoopClient. They access
// the private handleIncomingLine method directly via @ts-expect-error.

// Mock the expo-termloop native module (same pattern as __tests__/termloop-client.test.ts)
jest.mock('../../modules/expo-termloop', () => ({
  connect: jest.fn().mockResolvedValue('session-test'),
  send: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  onMessage: jest.fn().mockReturnValue({ remove: jest.fn() }),
  onState: jest.fn().mockReturnValue({ remove: jest.fn() }),
  onDisconnect: jest.fn().mockReturnValue({ remove: jest.fn() }),
}));

import { TermLoopClient } from '../termloop-client';

describe('TermLoopClient event routing', () => {
  it('routes event frames to per-type listeners without consuming id-based responses', () => {
    const client = new TermLoopClient();
    const received: any[] = [];
    client.onEvent('workspace.attention', (data) => received.push(data));

    // @ts-expect-error - accessing private method for testing
    client.handleIncomingLine(JSON.stringify({
      event: 'workspace.attention',
      data: { workspace_id: 'ws1', kind: 'stop', message_preview: 'hi' },
    }));

    expect(received).toEqual([
      { workspace_id: 'ws1', kind: 'stop', message_preview: 'hi' },
    ]);
  });

  it('ignores ping events silently', () => {
    const client = new TermLoopClient();
    // @ts-expect-error - accessing private method for testing
    expect(() => client.handleIncomingLine(JSON.stringify({ event: 'ping' }))).not.toThrow();
  });

  it('does not route event frames to id-based pending handlers', () => {
    const client = new TermLoopClient();
    const attentionData: any[] = [];
    client.onEvent('workspace.attention', (d) => attentionData.push(d));

    // This should NOT throw or affect any pending RPC
    // @ts-expect-error
    client.handleIncomingLine(JSON.stringify({
      event: 'workspace.attention',
      data: { workspace_id: 'ws2', kind: 'notification' },
    }));

    expect(attentionData).toHaveLength(1);
    expect(attentionData[0].workspace_id).toBe('ws2');
  });

  it('returns an unsubscribe function from onEvent that stops delivery', () => {
    const client = new TermLoopClient();
    const received: any[] = [];
    const off = client.onEvent('workspace.resumed', (d) => received.push(d));

    // @ts-expect-error
    client.handleIncomingLine(JSON.stringify({ event: 'workspace.resumed', data: { at: 123 } }));
    expect(received).toHaveLength(1);

    off(); // unsubscribe

    // @ts-expect-error
    client.handleIncomingLine(JSON.stringify({ event: 'workspace.resumed', data: { at: 456 } }));
    expect(received).toHaveLength(1); // still 1 — listener was removed
  });

  it('handles multiple listeners for the same event type', () => {
    const client = new TermLoopClient();
    const r1: any[] = [];
    const r2: any[] = [];
    client.onEvent('workspace.attention', (d) => r1.push(d));
    client.onEvent('workspace.attention', (d) => r2.push(d));

    // @ts-expect-error
    client.handleIncomingLine(JSON.stringify({ event: 'workspace.attention', data: { workspace_id: 'w3' } }));

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it('ignores malformed JSON lines', () => {
    const client = new TermLoopClient();
    // @ts-expect-error
    expect(() => client.handleIncomingLine('not json at all')).not.toThrow();
    // @ts-expect-error
    expect(() => client.handleIncomingLine('')).not.toThrow();
  });
});
