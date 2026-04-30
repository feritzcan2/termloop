export interface InitialCommandOpts {
  resumeId: string;
  cwd?: string;
  workspaceId?: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function normalizeContextPart(value?: string): string {
  return value?.trim() ?? '';
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function tmuxSessionName(
  resumeId: string,
  opts: Pick<InitialCommandOpts, 'cwd' | 'workspaceId'> = {},
): string {
  const base = `claude-${resumeId.replace(/[^A-Za-z0-9-]/g, '_')}`;
  const cwd = normalizeContextPart(opts.cwd);
  const workspaceId = normalizeContextPart(opts.workspaceId);
  if (!cwd && !workspaceId) {
    return base;
  }

  // Different worktrees can legitimately reuse the same Claude session id
  // after migration. Fold cwd/workspace into the tmux key so we reattach only
  // to the terminal that belongs to this resume context.
  const contextHash = fnv1a32(`${cwd}\n${workspaceId}`);
  return `${base}-${contextHash}`;
}

export function buildInitialCommand(opts: InitialCommandOpts): string {
  const { resumeId, cwd, workspaceId } = opts;
  const name = tmuxSessionName(resumeId, { cwd, workspaceId });
  const qName = shellQuote(name);

  const newSessionParts: string[] = [`tmux new-session -d -s ${qName}`];
  if (cwd && cwd.trim().length > 0) {
    newSessionParts.push(`-c ${shellQuote(cwd)}`);
  }
  if (workspaceId && workspaceId.trim().length > 0) {
    newSessionParts.push(`-e TERMLOOP_WORKSPACE_ID=${shellQuote(workspaceId)}`);
  }
  // Wrap claude in an interactive login zsh so ~/.zprofile and ~/.zshrc load
  // and PATH contains claude's install dir (brew/asdf/nvm/volta/mise/...).
  // After claude exits (normal or error), drop into `exec /bin/zsh -il` so
  // the tmux pane (and thus the session, and the SSH connection) stays alive
  // — otherwise one claude crash or early exit kills the whole chain and the
  // mobile client sees "[exited]" + disconnect with no way to diagnose.
  // Minimal, robust inner wrapper. Kept short (<400 chars) so the double
  // shellQuote wrapping doesn't explode into a multi-KB one-liner that some
  // SSH/PTY layers or shell parsers choke on.
  //
  //   1. Run `claude --resume` and leave any resume failure visible in the
  //      pane. Do not silently start a fresh Claude session; that makes an
  //      existing conversation look like it was reset on reconnect.
  //   2. Drop to an interactive zsh so the tmux pane and SSH connection
  //      stay alive for retry or inspection.
  //
  // Written without single quotes so outer shellQuote doesn't need to
  // escape them.
  const innerShell =
    `R=${shellQuote(resumeId)}; ` +
    `claude --resume "$R"; ` +
    `S=$?; ` +
    `if [ "$S" -ne 0 ]; then echo; echo "[claude resume failed with exit $S — no fresh session started]"; fi; ` +
    `echo; echo "[claude exited — Ctrl-D to close]"; ` +
    `exec /bin/zsh -il`;
  const innerWrapped = `/bin/zsh -lic ${shellQuote(innerShell)}`;
  newSessionParts.push(shellQuote(innerWrapped));
  const newSession = newSessionParts.join(' ');

  const lines = [
    'clear',
    // `tmux set-option -g` before the server exists silently fails under our
    // `2>/dev/null`; options end up as defaults (history-limit 2000, alt-screen
    // on, status on). Start the server first so subsequent -g options stick,
    // then create the session with correct defaults baked in at pane creation.
    'tmux start-server 2>/dev/null',
    'tmux set-option -g history-limit 100000 2>/dev/null',
    // Disable tmux's alternate-screen switch on attach so tmux output flows into
    // xterm.js's main buffer (and thus its scrollback). Without this, the user
    // attaches into an alt-screen buffer where finger-drag scroll is a no-op.
    'tmux set-option -g alternate-screen off 2>/dev/null',
    // Status bar redraws every second with absolute cursor addressing; in the
    // alt-screen-off main buffer xterm.js stacks each redraw on a new line
    // instead of overwriting, so the green `[session] window` bar piles up.
    // Mobile single-pane UX has no use for the bar — turn it off.
    'tmux set-option -g status off 2>/dev/null',
    // Force emacs copy-mode bindings so the keyboard bar's Mark / Word keys
    // (Space begin-selection, Alt-b / Alt-f word navigation) behave the same
    // regardless of the user's ~/.tmux.conf `mode-keys` setting.
    'tmux set-window-option -g mode-keys emacs 2>/dev/null',
    // On reattach, dump the full tmux scrollback before the live attach so a
    // cold app relaunch can reconstruct everything Claude printed while the
    // mobile client was gone. First launch skips the replay and just creates
    // the detached session.
    `if tmux has-session -t ${qName} 2>/dev/null; then tmux capture-pane -p -e -J -S - -t ${qName} 2>/dev/null; else ${newSession}; fi`,
    `exec tmux attach-session -d -t ${qName}`,
  ];

  return lines.join('; ') + '\n';
}
