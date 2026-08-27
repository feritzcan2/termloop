# Store agent rules

## Ownership

- Own versioned current-state persistence, migrations, transactions, optimistic
  revision checks, the bounded operation journal, and post-commit change events.

## Dependencies

- Allowed internal dependencies: `domain`, `platform`.
- No product policy, Git, providers, terminal, invocation, server, or clients.
- Durable mutation call sites are restricted to `core` by the enforced DAG and
  boundary scanner. Rust cross-crate visibility is not claimed as the guarantee.

## Invariants

- Persist current Project/Task/Session descriptors, current links/transcript, and
  bounded current operations; do not build event sourcing, Task history, Runs,
  Attempts, or a past-session list.
- Persist Jira association as an IssueLink sidecar, never in `TaskRecord`; allow
  at most one Jira link per Task and remove it atomically with Task deletion.
- Persist only the current optional Session name; previous names are not records.
- Persist only the exact current Ask-To caller ID plus a bounded continuation
  descriptor containing conversation ID and optional current request ID.
  Never infer legacy values or persist Ask-To text, replies, idempotency keys,
  bearer credentials, delivery history, or provider transcripts.
- Persist at most one bounded current description override per closed MCP tool;
  replace/reset it with revision CAS and never retain edit history.
- Persist the current agent model/permission/reasoning selection, migrate legacy
  Sessions to explicit defaults, and do not duplicate invocation's provider
  option catalog in store. A live Codex permission replacement must CAS the
  exact running Session/runtime epoch/ResumeRef, preserve model/reasoning, and
  leave the global launch preference unchanged.
- Persist one replace-in-place last successful ordinary Agent provider and
  launch selection; migration never infers it from legacy Sessions.
- Task worktree generation is monotonic and survives cleanup. Cleanup authority
  is bounded to one current journal and one latest receipt per Task, never history.
- Stale-resolution authority is likewise bounded to one current journal and one
  latest receipt; binding/proof clear and receipt replacement are one exact-tuple
  transaction.
- Generation/proof tuple CAS, operation-ID ownership, and binding/proof clear plus
  receipt replacement are single transactions; partial authority is never stored.
- A proven live non-force removal refusal may reset `removePrepared` to
  `reserved` for same-operation retry; timeout/output/crash ambiguity never does.
- Fresh acknowledged destructive intent may atomically supersede any different
  failed cleanup ID for the same exact Task/proof/generation/path tuple. An
  operation without a failure and fresh safe intent retain the operation slot.
- Mutations require named transaction intent and expected revision where the
  contract exposes concurrency.
- `CoreWriteAuthority` is a composition marker, not an unforgeable capability;
  CI ownership checks remain load-bearing.
- Never persist secrets, raw credential values, terminal bytes, or unfiltered
  process environments.
- Companion semantic kind/refs remain fields of the existing quota-bounded
  transcript row; never create a separate Steward activity/action log.
- Cache tables are disposable: wipe and re-derive must preserve product truth.

## Verification

- Run `cargo test -p termloop-store`.
- Add forward-migration, crash-journal, revision-conflict, secret-redaction, and
  cache-wipe fixtures for affected behavior.
