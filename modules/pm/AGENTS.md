# PM agent rules

## Ownership

- Own the Project Manager app's model and its own SQLite file
  (`<state directory>/pm/pm.sqlite`): sprints, tickets, immutable ticket
  description versions, and project environments. PM-only concepts live here,
  not in `domain`.

## Dependencies

- Allowed internal dependencies: `domain`, `platform`, `providers`,
  `invocation`, `agent-runtime`, `terminal`, `llm` (see
  `tools/ci/dag-rules.mjs`). Add an edge only when code here uses it.
- Never depend on `core` or `store`; the developer daemon's state is not PM
  state. External: `rusqlite`, `serde`, `thiserror`.

## Invariants

- Never persist secrets, credentials, or raw process output. A Jira link is
  only the exact secret-free `https://<host>/browse/<KEY>` URL.
- Every write is a named `PmStore` command that validates its parameters and
  runs in one transaction; never expose raw SQL writes.
- Derived data is never stored: a ticket's description is its newest version,
  and boards are assembled on read.
- A project has at most one active sprint (also a partial unique index). A
  closed sprint is frozen; leaving it unfinished increments the ticket's
  carry-over count.
- Description versions are immutable (an `UPDATE` trigger aborts); only whole
  oldest versions beyond the retention bound are dropped.
- Migrations are forward-only, recorded in `schema_migrations`, never edited
  once released; a database newer than the build is refused.

## Verification

- Run `cargo test -p termloop-pm`.
- Run `cargo clippy -p termloop-pm --all-targets -- -D warnings`.
