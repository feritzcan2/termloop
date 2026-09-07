# Platform agent rules

## Ownership

- Own all daemon-side OS adapters: PTY/process primitives, process-tree control,
  private provider-process ownership records and crash reconciliation,
  filesystem watch and atomic replace, path normalization, credential access,
  runtime/state directories, clock, randomness, and notifications.
- Generate fixed-width runtime capability bearers as primitive random values;
  callers own policy and keep values out of argv, persistence, and diagnostics.
- Return typed facts and portable handles; callers own product policy.

## Dependencies

- Internal dependencies: none.
- No domain policy, Git semantics, persistence schema, prompts, UI, or provider
  behavior.

## Invariants

- OS conditionals in production daemon code live here.
- On Windows, persist comparable drive-form canonical paths, opt Git into long
  paths, and pass filesystem arguments through the subprocess-path helper.
  Never compare raw verbatim (`\\?\`) paths with Git output.
- Generated paste bytes pass through the platform encoder. Windows ConPTY uses
  unframed content followed by settlement-aware Enter; Unix PTYs use
  `ESC[200~...ESC[201~` bracketed-paste framing. Do not introduce a fixed
  paste-to-Enter delay.
- Durable state directories and ephemeral runtime/discovery directories are
  distinct on every OS.
- A consume-once bounded runtime metadata read removes its exact file whether
  decoding succeeds or fails; callers own format and policy, and no watcher or
  polling behavior is implied.
- Explicit runtime/state overrides win. Debug linked-worktree builds use a
  compile-time checkout profile fallback; primary and release defaults do not
  change.
- Process termination covers the child tree and reaps it. Failure does not make
  the process handle unreachable.
- New process primitives use argument vectors rather than a shell and expose
  explicit timeout, output bounds, stdin, environment-delta, and tree-termination
  semantics. The legacy unbounded `probe_command` is not a template for new work.
- Crash reconciliation signals only a process whose current OS start identity
  matches the private ownership record; PID reuse is treated as stale metadata.
- `unsafe` is forbidden except at the narrowest documented platform FFI scope,
  with an adjacent `// SAFETY:` argument and focused test; never allow it across
  an entire function when a smaller expression/block suffices.
- Secrets are returned as opaque credentials or references, not logged strings.
- Exact stale-directory removal is shell-free, bounded, non-following, and
  identity-checked. Platform returns primitive hazard facts; core owns policy.
- Child processes receive an opaque allowlist-reconstructed environment. Do not
  use ambient `std::env::vars*` outside the environment adapter or rely on
  `Command`/PTY default inheritance.

## Verification

- Run `cargo test -p termloop-platform`.
- Run `cargo clippy -p termloop-platform --all-targets -- -D warnings`.
- Run platform-specific fixtures on every affected target; a cross-check alone
  is not runtime evidence.
