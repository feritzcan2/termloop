import { buildInitialCommand, tmuxSessionName } from '../lib/terminal-command';

describe('tmuxSessionName', () => {
  test('passes through UUID-like ids unchanged', () => {
    expect(tmuxSessionName('abc123-def4-5678-90ab-cdef12345678')).toBe(
      'claude-abc123-def4-5678-90ab-cdef12345678'
    );
  });

  test('replaces unsafe chars with underscore', () => {
    expect(tmuxSessionName('weird.id:with spaces')).toBe('claude-weird_id_with_spaces');
  });

  test('allows hex, digits, letters, dashes', () => {
    expect(tmuxSessionName('A1-b2-C3')).toBe('claude-A1-b2-C3');
  });

  test('adds a stable context suffix when cwd is present', () => {
    const first = tmuxSessionName('abc123-def4-5678-90ab-cdef12345678', {
      cwd: '/Users/foo/proj',
    });
    const second = tmuxSessionName('abc123-def4-5678-90ab-cdef12345678', {
      cwd: '/Users/foo/proj',
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^claude-abc123-def4-5678-90ab-cdef12345678-[0-9a-f]{8}$/);
  });

  test('distinguishes different worktree contexts for the same resume id', () => {
    const a = tmuxSessionName('same-id', { cwd: '/repo/.termloop-worktrees/a' });
    const b = tmuxSessionName('same-id', { cwd: '/repo/.termloop-worktrees/b' });
    expect(a).not.toBe(b);
  });
});

describe('buildInitialCommand', () => {
  const UUID = 'abc123-def4-5678-90ab-cdef12345678';
  const NAME = `'claude-${UUID}'`;

  test('basic resume-only command chain', () => {
    const out = buildInitialCommand({ resumeId: UUID });
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('clear');
    expect(out).toContain('tmux start-server');
    expect(out).toContain('history-limit 100000');
    expect(out).toContain('alternate-screen off');
    expect(out).toContain('tmux set-option -g status off');
    expect(out).toContain(`tmux has-session -t ${NAME}`);
    expect(out).toContain(`tmux new-session -d -s ${NAME}`);
    expect(out).toContain(`tmux capture-pane -p -e -J -S - -t ${NAME}`);
    expect(out).toContain(UUID);
    expect(out).toContain('claude --resume "$R"');
    expect(out).toContain(`exec tmux attach-session -d -t ${NAME}`);
  });

  test('wraps claude in login+interactive zsh without starting a fresh session on resume failure', () => {
    const out = buildInitialCommand({ resumeId: UUID });
    expect(out).toContain('/bin/zsh -lic');
    expect(out).toContain(UUID);
    expect(out).toContain('claude --resume "$R"; S=$?;');
    expect(out).toContain('no fresh session started');
    expect(out).not.toContain('resume unavailable');
    expect(out).not.toContain('; claude;');
    // Interactive shell keeps the tmux pane alive for inspection.
    expect(out).toContain('exec /bin/zsh -il');
    expect(out).toContain('claude exited');
  });

  test('includes cwd when provided', () => {
    const out = buildInitialCommand({ resumeId: UUID, cwd: '/Users/foo/proj' });
    const name = tmuxSessionName(UUID, { cwd: '/Users/foo/proj' });
    expect(out).toContain(`-s '${name}' -c '/Users/foo/proj'`);
  });

  test('quotes cwd with spaces and embedded quotes', () => {
    const out = buildInitialCommand({ resumeId: UUID, cwd: `/Users/foo bar/it's` });
    expect(out).toContain(`-c '/Users/foo bar/it'\\''s'`);
  });

  test('includes TERMLOOP_WORKSPACE_ID when provided', () => {
    const out = buildInitialCommand({ resumeId: UUID, workspaceId: 'wid-7' });
    const name = tmuxSessionName(UUID, { workspaceId: 'wid-7' });
    expect(out).toContain(`-e TERMLOOP_WORKSPACE_ID='wid-7'`);
    expect(out).toContain(`-s '${name}'`);
  });

  test('combines cwd and workspaceId', () => {
    const out = buildInitialCommand({
      resumeId: UUID,
      cwd: '/foo',
      workspaceId: 'wid-7',
    });
    const name = tmuxSessionName(UUID, { cwd: '/foo', workspaceId: 'wid-7' });
    expect(out).toContain(`-s '${name}'`);
    expect(out).toContain(`-c '/foo' -e TERMLOOP_WORKSPACE_ID='wid-7' '/bin/zsh -lic`);
    expect(out).toContain(UUID);
  });

  test('omits cwd / env flags for empty or whitespace values', () => {
    const out = buildInitialCommand({ resumeId: UUID, cwd: '  ', workspaceId: '' });
    expect(out).not.toContain('-c ');
    expect(out).not.toContain('TERMLOOP_WORKSPACE_ID');
  });

  test('sanitizes non-UUID resumeId in session name', () => {
    const out = buildInitialCommand({ resumeId: 'weird.id:bad' });
    expect(out).toContain(`'claude-weird_id_bad'`);
    expect(out).toContain('/bin/zsh -lic');
    // Raw resume id is passed via shell variable assignment.
    expect(out).toContain('weird.id:bad');
  });
});
