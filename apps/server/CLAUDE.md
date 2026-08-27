# Server agent rules

## Ownership

- This app is the daemon composition root: wire generated protocol handling to
  `core` and the binary data plane to `terminal`; publish secure local discovery.
- Project checkout summaries and content reads execute core-owned plans through
  the shared fair Git observation gate and never run Git while holding the core
  lock.
- It owns one bounded Companion child supervisor and the disposable
  Project-deduplicated wake queue. It exposes one HTTP MCP endpoint with exact
  interactive, Steward, Worker, and helper
  profiles; process primitives remain in `platform`.
- `platform` access is limited to runtime/state discovery, private-file
  primitives, and daemon-start process reconciliation. Anything broader needs a
  explicit user scope rather than a convenient composition-root call site.

## Dependencies

- Allowed internal dependencies: `contract`, `core`, `terminal`, `platform`.
- No domain policy and no direct store/Git/provider/agent/invocation/observability
  access that bypasses `core`.

## Invariants

- Bind loopback by default and publish discovery with private permissions.
- Authenticate and capability-check before method dispatch. Different client
  roles receive distinct scopes; denied calls emit `capabilityDenied`. `/mcp`
  advertises only schema-generated role tools; auth/initialize/tool listing use
  core's independent bearer handle and never acquire the serialized core lock.
- Effective MCP copy overlays only generated `description` through core's
  read-only snapshot; all other generated definition and authority fields remain exact.
- `task_set_jira_url` dispatches only for an authenticated Steward principal;
  Project scope and append-once policy remain in core.
- `steward_system_prompt_read` and `steward_system_prompt_update` dispatch only
  for the authenticated current Steward. Core returns the complete editable
  source, proves the exact newest user message, rejects a stale expected source,
  and commits the complete modified prompt; server only retires the exact old
  Session and requests the existing supervised inspected relaunch.
- Steward wake acknowledgement is completion-aware: an existing Session must
  receive the wake, while an accepted new-launch handoff owns rollback and
  current-generation requeue on process-start failure.
- Never await or block on Git/provider/process work while holding the serialized
  core lock. Plan under lock, execute outside it, then re-lock and apply.
- Archive/restore dispatch must preserve that plan/observe/apply rule, publish
  Task+Session+Agent invalidation, and map archive conflicts from generated
  typed details without server-owned lifecycle policy.
- The same boundary applies to stale-worktree observation and recursive removal;
  server maps the generated command but owns no eligibility policy.
- Control JSON never carries PTY bytes. Terminal data uses bounded binary frames.
- Ambient Steward presence may project only a server-timestamped, byte-free
  executor activity fact and the currently nested authenticated Steward MCP
  tool label. Both maps are bounded, runtime-only, and disposable.
- Generate a fresh runtime epoch and per-role credentials on every daemon start.
  Root policy assigns randomness to `platform`; the current local random calls
  are boundary debt and must not be copied into new paths.
- Resume must register the role planned by core. An Ask-To helper never falls
  back to the interactive profile, persistent Steward/Worker replacement-resume
  must retain its exact closed role, and no pre-restart bearer is accepted. A
  fresh Codex launch or resume bearer may authenticate MCP initialization before
  readiness, but every `tools/call` re-authenticates command authority before
  dispatch and remains denied until core commits the exact Session and epoch.
- Never print or place tokens in argv, URLs, logs, evidence, or renderer globals.
- The hook-only Claude native Session ID input is bounded and one-Session-token
  scoped; never return, broadcast, or log it.
- Graceful daemon shutdown may write only the bounded private agent restart
  handoff; startup consumes it once before automatic resume. It is not
  a status store, watcher, transcript source, or reason to separate desktop and
  daemon lifecycles.

## Verification

- Run `cargo test -p termloop-server`.
- Run `pnpm acceptance:s0`.
- Test concurrent clients, denied methods, oversize messages, discovery
  permissions, stale epochs, and slow terminal attachments.
