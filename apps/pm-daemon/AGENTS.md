# PM daemon agent rules

## Ownership

- Own `termloop-pm-daemon`, the local, single-user Project Manager daemon:
  one loopback listener (`127.0.0.1:<random port>`) serving the PM control
  plane (`/control`), the binary terminal plane for PM agent PTYs
  (`/terminal`), the MCP endpoint PM agents call (`/mcp`), and `/healthz`.
- Own the process lifecycle: the instance lease and managed-process
  registries under `<runtime directory>/pm`, the runtime epoch, the one
  bearer of a run, and the private `pm/discovery.json` clients read.
- Own PM agent sessions (`src/app/agents.rs`): launch through
  `termloop_pm::agent` and `agent-runtime`, per-agent MCP bearers and config
  files, stop, and exit handling.
- Own the schedulers (`src/app/scheduler.rs`): delivery-check ticks, probe
  runs, commit-ancestry answers through `gitio`, and the Jira/GitHub fact
  refresh.
- Own provider calls for the PM: Jira through `providers::JiraCloudClient`,
  pull requests through `providers::GitHubClient`, and Jira API tokens in
  the platform secure credential store (`src/app/credentials.rs`).
- `modules/pm` owns the model, the store, and every write; this crate only
  adapts the wire, schedules, and performs I/O around `PmStore` commands.
- File split: `control/` (framing, auth, dispatch, errors, operations),
  `terminal.rs`, `mcp.rs`, `agents.rs`, `scheduler.rs`, `credentials.rs`,
  `discovery.rs`, `jira.rs`. Keep each under about 1,000 lines.

## Dependencies

- Allowed internal dependencies: `pm-contract`, `pm`, `platform`,
  `terminal`, `terminal-wire`, `agent-runtime`, `launch`, `agents`,
  `providers`, `gitio`, `llm` (see `tools/ci/dag-rules.mjs`). Add an edge
  only when code here uses it.
- Never depend on `core`, `store`, `contract` (the developer control
  contract), or `server`. The PM daemon never reads or writes the developer
  daemon's state.

## Invariants

- Every control request is decoded, its protocol identity checked, and its
  bearer compared in constant time before the method is looked up or
  dispatched. Only the `pm.full` scope exists.
- Every method result is validated against the generated contract before it
  is sent; a result outside it becomes `internal`. Every failure carries one
  schema error code; store internals stay in the daemon log.
- Absent and `null` differ in update params: absent keeps a field, `null`
  clears it. Read nullable fields from the raw params, not the generated
  struct.
- Events (`pmBoardChanged`, `pmAgentChanged`, `pmCheckChanged`,
  `pmJiraPulled`) are validated against the contract and reach only
  connections that subscribed with `pm_subscribe`.
- Secrets never appear in logs, argv, URLs, events, results, or the PM
  SQLite file. `pm_credential_store` returns only `{credentialHandle}`.
  Bearers never appear in logs or argv; the discovery file is private.
- Never hold the store lock across a network call or a child process. Jira
  writes run on a second SQLite connection on a blocking task.
- An MCP tool call's project, mode, and ticket come only from the calling
  agent's bearer, never from tool arguments.
- PTY bytes travel only in binary terminal frames, never in JSON.
- A delivery check agent runs with the non-interactive `checkPermission`;
  an agent that exits without its report closes its check as failed. Each
  tick abandons overdue checks; startup abandons every running check of the
  earlier run. The store allows one running check per ticket.
- Shutdown terminates every agent PTY and removes the discovery file and
  agent MCP config files.

## Verification

- Run `cargo test -p termloop-pm-daemon -p termloop-pm`.
- Run `cargo clippy -p termloop-pm-daemon -p termloop-pm --all-targets -- -D warnings`.
- Run `pnpm acceptance:pm-smoke` after a control-plane change.
- Run `pnpm architecture:dag` and `pnpm architecture:boundaries` after a
  dependency change.
