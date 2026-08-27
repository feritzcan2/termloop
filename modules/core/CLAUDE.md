# Core agent rules

## Ownership

- Own named command handlers, cross-resource orchestration, the sole durable
  write path, and read projections for projects, Tasks, Sessions, presence,
  Active Agents, checkout health, PR composition, Companion conversation,
  Steward, Workers, and Worker Tasks.
- Project checkout summaries and content observations are bounded read plans;
  Git work runs outside the serialized core lock, revalidates the ephemeral
  checkout proof, and never becomes durable Project state.
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
- Blocking Git/provider/process preparation and teardown run outside the
  serialized core lock. Use plan/observe/apply boundaries and revalidate current
  state before applying externally observed facts.
- Task worktree is optional. Branch bindings are unique per repository/project;
  conflicts name the holding Task.
- Worktree provisioning is an idempotent journaled operation and exposes at most
  one current actionable failure per Task, not a history.
- Worktree health/presence caches are bounded projections with captured
  sequences. Cleanup is generation/proof-CAS, journaled, revalidates every
  destructive gate, and reserves only its exact Task/path against new launches.
- A fresh acknowledged destructive cleanup may atomically replace any failed
  cleanup journal for the same exact Task/proof/generation/path only after new
  observation passes every current safety gate. An active journal remains
  non-supersedable, and fresh safe intent cannot replace a failed journal.
- Multiple write-capable agents in one worktree remain allowed. Presence,
  writer count, Active Agents, blocked/attention, health, and PRs are projections.
- PR composition keeps the durable Task branch, bounded exact-worktree branch
  evidence returned by `gitio`, and only separator-delimited local branch-family
  aliases derived from that evidence. Enumeration is bounded and filtered
  before provider work; core never stores branch history or rebinds the Task.
- An exact registered managed worktree remains launchable after an agent checks
  out another attached local branch when fresh registration and repository HEAD
  agree. Explicit cleanup is permitted under that same exact positive matrix;
  neither path rebinds the Task or loosens repair/stale-disposal policy.
- Close has no filesystem effect. Cleanup is explicit and fail-closed; delete
  follows the accepted delete semantics and cannot bypass cleanup safety.
- Stale binding forget is record-only. Its separate recursive disposal
  command is journaled, explicitly acknowledged, exact-path reserved, and must
  revalidate Git, Session, protected-path, and leaf identity gates before removal.
- Launch accepts only a valid provenance-bearing payload from `invocation`.
- Native fork is a named Session command derived from a live source Session; it
  derives the bounded `<source display name> fork-1` child name, creates no
  durable parent/history relation, and never exposes ResumeRef.
- Agent launch planning and resume consume invocation-owned manifests; core does
  not compose or append agent content, argv, environment, generated files, or
  initial input. One-time preview tickets bind Quick Action, Project, Task, and
  user-requested resume execution to the inspected private payload.
- `runtime/generated_input_delivery.rs` is the sole orchestrator for every
  invocation-owned generated terminal submission, including all initial-input,
  resume, Ask-To, handover, agent-message, assignment, Steward, Companion, and
  Worker paths. Feature handlers submit the immutable
  `GeneratedTerminalSubmission`; they never call terminal input-sequence or
  receipt-bearing atomic write primitives directly and never recompose content.
  Transport receipt is not delivery: only newer same-epoch provider evidence may
  confirm and clear delivery-dependent state. Never replay content or use fixed
  paste-to-Enter delays or automatic Enter retries.
- Core stores the effective launch selection with the current agent Session,
  inherits it for native fork, and passes it unchanged to automatic/manual
  resume; helper roles without user selection use explicit defaults. A live
  Codex permission observation may replace only that Session's permission after
  exact Session/runtime epoch/native thread revalidation; it never changes the
  global launch preference.
- A client-launch restart snapshots runtime-only Codex status before replacing
  the process. Graceful whole-app shutdown may additionally export one bounded
  exact-PTY handoff of working Claude/Codex tuples; daemon-start resume
  revalidates Session/provider/old epoch before seeding either as
  `process/interrupted`. Claude `SessionStart` may idempotently confirm its
  existing ResumeRef while the exact token-bound reservation is `resuming`.
  Core never stores general status or reconstructs a missing fact.
- Core atomically remembers the last successful ordinary Agent provider and
  launch selection; Steward Task Agent start replays that exact tuple, while
  Steward, Worker, and helper launches never replace it.
- Ask-To text, reply content, delivery history, idempotency, role capabilities,
  and bearers are bounded and runtime-only. The helper descriptor persists only
  exact conversation/request IDs so restart can rebuild routing until reply or
  endpoint exit. Server authentication uses core's independent read-only bearer
  handle; each resumed helper receives a fresh helper-profile bearer bound to
  its new runtime epoch. Fresh Codex launch and resume may stage their bearer for
  transport-only MCP initialization before readiness; commands remain denied
  until commit and abandoned plans revoke the staged bearer. Each
  command re-authenticates in core; helpers remain reply-only and Task-attached launch uses the existing
  plan/observe/revalidate path.
- Live Ask-To reuse is bound to the original asker/helper/Project/target/epochs.
  It requires structured idle, rebinds the exact helper reply capability, and
  can deliver only invocation's versioned follow-up payload.
- Helper completion queues one versioned final reply for the exact source asker;
  structured idle triggers atomic delivery and no polling surface exists.
- The authenticated Steward profile may re-enter the named ordinary Task
  commands and the same-Project atomic managed-worktree,
  preview-ticket-backed Task Agent launch/reuse, and initial assignment
  delivery, and may send an invocation-composed visible message to an ordinary
  running Agent in the same Project. Only the current Steward may read and
  replace its own bounded editable Project instructions when the cited exact
  newest Companion message is user-authored. Replacement requires the exact
  complete source value returned by the read and fails on a stale source; Core
  clears the old executor binding and never accepts Project or Session scope
  from arguments. Invocation retains the built-in wake/safety layer at launch.
  Workers may report bounded current findings but cannot mutate Tasks or
  contact Task Agents.
- Session projection may expose the exact live Ask-To source for a helper. The
  source and bounded continuation provenance survive restart, but never become
  parentage, history, lifecycle cascading, content storage, or bearer authority.
  Permanent endpoint exit clears continuation; retryable resume failure keeps
  it without granting live MCP authority.
- MCP description settings are named revision-CAS commands. Only description is
  mutable; the post-commit effective snapshot cannot change tool authority,
  schema, annotations, roles, or dispatch.
- Interactive, Steward, Worker, and helper MCP principals are Session- and
  runtime-epoch-bound. Their closed role profile is authenticated by core and
  cannot be selected by prompt text or caller input. Generic replacement-resume
  re-derives persistent Steward/Worker roles only from their exact current
  enabled executor configuration; stale, mismatched, or ambiguous assistant
  identity receives no MCP credential and never falls back to Interactive.
- Companion mutations arrive only as ordinary capability-checked commands that
  apply a visible approved proposal.
- Companion message semantics are explicit typed values. Core never parses
  content to infer proposals/actions, and successful Steward action receipts
  stay inside the existing bounded transcript.
- The Project-bound Steward may append one exact Jira IssueLink only while the
  Task has none; replacement and cross-Project addressing fail closed.
- Steward Task Agent assignment composition reads any Jira URL from that
  sidecar and passes it through invocation for both new and reused Agents; do
  not infer link identity from the caller's assignment text.

## Verification

- Run `cargo test -p termloop-core`.
- Add command/conformance tests for the affected sub-boundary, including failure,
  revision conflict, idempotency, and projection re-derivation cases.
