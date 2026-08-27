# Observability agent rules

## Ownership

- Own bounded operational rings, file/HEAD/index-lock signals, retention policy,
  and non-blocking Safety Snapshot recovery storage.

## Dependencies

- Allowed internal dependencies: `gitio`, `platform`.
- No launch policy, write leases, file locks, product history, Task/session
  ownership, or writer-count projection ownership.

## Invariants

- Telemetry is bounded, TTL'd where appropriate, disposable, and never read as
  domain truth.
- Safety Snapshot objects live outside the user's repository object database,
  never touch the user's index/worktree, exclude ignored/secrets by policy, and
  have literal retention bounds.
- Signals may warn and recover; they never block a second writer or serialize
  agent Git operations.
- `core` may publish derived writer-presence facts as trigger input; this module
  does not independently own or persist that projection.

## Verification

- Run `cargo test -p termloop-observability`.
- Test retention/GC, secret and ignored-file exclusions, repo-index integrity,
  pre-write snapshots, burst eviction, and restoration limits.
