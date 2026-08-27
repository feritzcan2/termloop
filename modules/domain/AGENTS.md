# Domain agent rules

## Ownership

- Own pure domain types, value objects, invariants, transitions, and projection
  functions. Keep all behavior deterministic and independently testable.

## Dependencies

- Internal dependencies: none.
- No filesystem, network, clock, randomness, process, Git, persistence, UI, or
  platform-specific API.

## Invariants

- Task status is only `open | closed`; its worktree is optional, and a worktree
  binding implies a branch binding.
- IssueLink is a provider-neutral sidecar value; never add provider or remote
  fields to `TaskRecord`.
- Session is Project-scoped. Task presence and Active Agents are derived.
- Archive is a nullable Task current-state marker, never a third status. Archive
  suspension values remain sidecars and never make Sessions Task children.
- A Session name is optional user-authored current state; never add rename history.
- An Ask-To helper Session may carry one nullable caller ID and one bounded
  current continuation descriptor containing only conversation/request IDs.
  They are current routing provenance, never generic parentage,
  bearer authority, content, ownership, or history.
- MCP tool-description overrides use the closed tool identity and the bounded,
  whitespace-exact domain value; never add edit history or tool behavior here.
  The Steward self-prompt tool adds identity only; its authorization
  and transcript provenance policy remain in core.
- Agent launch selection is bounded, secret-free current Session state; keep
  provider-specific catalogs outside domain.
- Do not introduce Workspace, Run, Attempt, Task history, stored blocked state,
  stored Active Agents, or domain-owned Layout.
- Companion message kind and optional Task/Session refs are validated values;
  no reducer infers action/proposal semantics from message text.
- Domain never canonicalizes, normalizes, or string-prefixes paths. Core maps
  platform path facts into domain-owned opaque comparison keys; domain performs
  only pure equality/containment and owns no OS path policy.

## Verification

- Run `cargo test -p termloop-domain`.
- Run `cargo clippy -p termloop-domain --all-targets -- -D warnings`.
