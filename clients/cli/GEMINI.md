# CLI client agent rules

## Ownership

- Own the scriptable command-line client over the generated control protocol and
  binary terminal attachment protocol.

## Dependencies

- Internal dependency: generated `contract` client only.
- No direct database, Git, filesystem mutation, process spawn, daemon internals,
  or private provider access.
- Node filesystem/network/process APIs and OS branching live only in
  `src/platform/**`; CI enforces this through `CLIENT_PRIVILEGE` and
  `OS_CONDITIONAL_OWNER`.

## Invariants

- Discover the daemon through the documented private runtime file; do not accept
  secrets in argv, print tokens, or embed them in URLs.
- Expose only methods permitted by the client's capability scope and surface
  typed protocol errors without inventing domain meaning.
- Streaming terminal data remains binary and backpressure-aware.
- Output intended for scripts is stable, explicit, and separate from human
  diagnostics.

## Verification

- Run `pnpm --filter @termloop/cli check`.
- Run `pnpm --filter @termloop/cli test`.
- Exercise discovery, capability denial, daemon unavailable, and structured output.
