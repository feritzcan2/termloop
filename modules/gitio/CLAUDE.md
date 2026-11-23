# Git I/O agent rules

## Ownership

- Own Git discovery and typed repository, ref, worktree, mutation, status,
  remote, and snapshot primitives.
- Return explicit facts and typed failures. Never decide Task binding, cleanup
  safety, launch eligibility, or provider meaning; core maps facts to policy.
- No durable state, global runner, singleton, or Git mutex.

## Dependencies

- Allowed internal dependency: `platform` only.

## Invariants

- Execute Git only through the `GitRunner` and platform's argument-vector
  runner. Never compose a shell command.
- The API is synchronous. Every repository call has an explicit cwd, bounded
  output, and a timeout.
- Read-only observation never writes the index, creates `index.lock`, runs
  hooks, prompts, or touches the network.
- Never put secrets in argv, logs, or errors. Public errors carry a stable
  classification, never raw stderr, URLs, or user paths.
- Preserve path and ref bytes: use NUL-delimited plumbing, no lossy UTF-8.
  Validate exact ref names; never accept revision expressions or compose
  `rev:path` strings.
- Expose unknown and truncated states honestly; never collapse uncertainty into
  `false`, `clean`, or `safe`.
- Delete and remove primitives are exact and non-force. Never recursively
  delete, prune, or choose a branch or path on the caller's behalf.

## Tests

- Use hermetic repositories: no global config, fixed identity and time,
  disabled hooks, isolated HOME.
- Read-only observations assert the index is unchanged and no `index.lock`
  remains.

## Verification

```text
cargo test -p termloop-gitio
pnpm ci:git-owner
```
