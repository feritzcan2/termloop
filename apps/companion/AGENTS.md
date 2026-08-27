# Companion app agent rules

## Ownership

- Companion is a separate unprivileged protocol client. It reads authorized
  projections, maintains the bounded transcript/wake loop, and never acquires
  the authenticated Steward Session's Task mutation authority.

## Dependencies

- Internal dependency: generated `contract` client only. Tokio, Tungstenite,
  and serialization helpers are allowed solely for the exact-current
  loopback control client.
- No direct `core`, `store`, `domain`, `platform`, filesystem, Git, provider SDK,
  raw provider HTTP, credential, terminal, invocation, or LLM module access.
- The only network endpoint is the supervisor-supplied loopback `/control`
  WebSocket; arbitrary URLs, TLS/provider endpoints, and discovery-file reads
  fail closed.
- LLM work goes through the capability-scoped daemon protocol.

## Invariants

- Companion owns opinion, never domain truth. Task mutations belong to the
  authenticated persistent Steward MCP profile or a full-control user action.
- It cannot receive mutation methods outside its declared capability set.
- Companion-authored launch material uses visible prompt templates and normal
  invocation provenance.
- Transcript limits surface before refusal and compact only through an explicit,
  user-visible policy; never silently discard current user-authored context.

## Verification

- Run `cargo test -p termloop-companion`.
- Test capability denial, transcript bounds, and that privileged imports/network
  paths fail architecture checks.
