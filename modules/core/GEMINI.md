# Core agent rules

## Ownership

- Own named command handlers, cross-resource orchestration, the sole durable
  write path, and read projections for projects, Tasks, Sessions, presence,
  Active Agents, checkout health, PR composition, Companion, Steward, Workers,
  and Worker Tasks.
- Sub-boundaries are `project`, `task_worktree`, `session_launch`,
  `companion_integrations`, and `runtime`, each addressed as `src/<name>.rs` and
  `src/<name>/**`. Parallel work is assigned by whole sub-boundary.
- Feature handlers never import sibling feature handlers. Shared transaction
  behavior goes through private `runtime` ports.

## Dependencies

- Allowed internal dependencies: `domain`, `store`, `gitio`, `providers`,
  `agents`, `invocation`, `terminal`, `observability`, `llm`, `platform`.
- No dependency on `contract`, `server`, apps, or clients.

## Invariants

- Only named commands mutate durable state; no generic `save`, setter, or
  frontend-owned transaction path.
- Blocking Git, provider, and process work runs outside the serialized core
  lock. Use plan/observe/apply and revalidate current state before applying
  externally observed facts.
- Destructive filesystem work (worktree cleanup, stale disposal) is explicit,
  journaled, and fails closed when any safety gate cannot be proven. Close
  never touches the filesystem.
- Agent launch, resume, and generated content come from `invocation`
  manifests. Core never composes argv, environment, prompts, or initial input.
- Every generated terminal submission goes through
  `runtime/generated_input_delivery.rs`. No fixed paste-to-Enter delays or
  automatic Enter retries.
- MCP principals (Interactive, Steward, Worker, helper) are bound to Session
  and runtime epoch and authenticated by core. A role is never selected from
  prompt text or caller input, and an ambiguous identity gets no credential.
- Ask-To content, bearers, and delivery state are bounded and runtime-only.

## Verification

- Run `cargo test -p termloop-core`.
- Add command tests for the affected sub-boundary, including failure, revision
  conflict, and idempotency cases.
