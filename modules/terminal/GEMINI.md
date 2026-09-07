# Terminal agent rules

## Ownership

- Own daemon PTY/process Sessions, attach/detach, input, resize, termination,
  liveness, and bounded binary fan-out to clients.

## Dependencies

- Allowed internal dependency: `platform` only.
- No Task/worktree knowledge, Git, prompts, resume policy, durable state, UI,
  renderer, or VT-grid persistence.

## Invariants

- PTY bytes are binary frames and never enter control-plane JSON/base64.
- Output activity observers receive only Session/epoch facts; they never receive
  timestamp policy or a copy/encoding of PTY bytes.
- The bounded atomic-input primitive preserves one caller-provided byte
  sequence; terminal must not learn prompt, MCP, conversation, or readiness
  policy from its use.
- Receipt-bearing atomic input, settlement observation, and guarded submit are
  transport primitives for Core's shared generated-input coordinator only; they
  never imply provider delivery. Do not add feature-specific prompt sequencing,
  fixed paste-to-Enter timing, content replay, or Enter retry policy here.
  Direct client input remains the separate user-input path.
- Detach does not terminate. Daemon restart may create a new PTY and explicitly
  resume an agent; screen/scrollback restoration is not promised.
- Each attachment has a bounded outbound queue. Overflow is session-local and
  visible through a gap/error signal; one slow session cannot stall input or
  output for unrelated Sessions.
- Enabled agent generations retain a rolling, bounded 1 MiB memory-only recent
  output ring. Every attachment receives a frozen replay snapshot followed by
  live bytes; eviction is explicit through a gap event. The ring ends with the
  runtime and is never a durable log, VT grid, or exact screen checkpoint.
- Do not hold a global registry lock across blocking PTY I/O.
- Termination kills and reaps the process tree before the Session becomes
  unreachable.
- Runtime epoch is unique per daemon start and rejects stale attachments.
- PTY spawn clears the builder's ambient environment snapshot and applies only
  the complete `LaunchEnvironment` supplied by its caller. Terminal owns no
  allowlist or agent-specific environment policy.
- Agent PTYs execute the already resolved invocation payload. Terminal must not
  append or transform agent argv/environment, generated instructions, or
  initial input after manifest resolution.

## Verification

- Run `cargo test -p termloop-terminal`.
- Exercise flood plus interactive peers, resize ordering, detach/reattach,
  process-tree termination, queue overflow, and epoch mismatch.
