# PM agent rules

## Ownership

- Own the Project Manager app's model and its own SQLite file
  (`<state directory>/pm/pm.sqlite`): sprints, tickets, immutable ticket
  description versions, agent proposals, project environments and sources,
  delivery facts, delivery probes, and delivery checks. PM-only concepts live
  here, not in `domain`.
- Own the PM agent (`src/agent`): its role copy and launch-time system
  prompt, its MCP tool definitions and handlers, and its launch plan through
  `launch`. The daemon owns the MCP endpoint, the bearer token, the PTY, the
  check scheduler, and credential reads.
- Do no network or Git I/O here. Callers read Jira, pull requests, and Git
  through `providers`/`gitio` and hand the answers to `PmStore` commands.

## Dependencies

- Allowed internal dependencies: `domain`, `platform`, `providers`,
  `invocation`, `launch`, `agent-runtime`, `terminal`, `llm` (see
  `tools/ci/dag-rules.mjs`). Add an edge only when code here uses it.
- Never depend on `core` or `store`; the developer daemon's state is not PM
  state. External: `rusqlite`, `serde`, `serde_json`, `sha2`,
  `thiserror`.

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
- Project sources hold only non-secret identifiers: the normalized Jira site
  URL, board id, account email, a `platform` credential handle name, and the
  GitHub owner/name. Never a token.
- Delivery facts are observations, stored per ticket. A failed or missing
  read keeps the last good value and records the failure; facts older than
  `FACTS_STALE_AFTER_MS` are shown as stale. Stages, risks, check reasons,
  and the data tier are derived on read and never stored.
- Deploy tracking is on only when the project lists environments or has an
  approved probe. With neither, a ticket never gets a check reason.
- A proposed probe never runs; only the PM's approval (or a PM-written
  probe) lets it. A run of a probe that changed meanwhile is refused.
- A project whose Jira source names a board mirrors that board's sprints:
  Jira owns a mirrored sprint's name, end, and state, and which linked issues
  its active sprint holds; unlinked tickets keep the PM's sprint. A failed
  pull, or one planned against changed sources or older than the last applied
  pull, changes nothing. A closed sprint is never reopened by a pull.
- Jira is written only with a diff the PM confirmed: the confirmation token
  is the diff's hash, and applying re-reads Jira and refuses when the diff
  differs. A credential is used only for an issue whose browse URL starts
  with `{normalized site}/browse/` of the project's Jira source.
- PM agent tools never write Jira, a Git host, or any external system; they
  read the PM store and write only proposals and check reports. A tool
  outside the caller's mode is denied, a ticket outside its project is not
  found, and a delivery check works on its own ticket only.
- An agent never changes a ticket directly: it records a proposal. Only the
  PM's acceptance turns a description proposal into a version (author
  `agent`), and only while the version it was made against is the newest.
- The MCP bearer token is a launch parameter only: it reaches the agent
  through the child environment, never argv, Debug output, errors, or the
  store.
- Delivery checks exist only for a project with deploy tracking: one running
  check per ticket (also a partial unique index), a bounded number per
  project, closed by the report, the daemon, or the deadline.
- Migrations are forward-only, recorded in `schema_migrations`, never edited
  once released; a database newer than the build is refused.

## Verification

- Run `cargo test -p termloop-pm`.
- Run `cargo clippy -p termloop-pm --all-targets -- -D warnings`.
