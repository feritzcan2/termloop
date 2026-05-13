# TermLoop DevServers — Agent Context

This folder owns project-scoped run profile configuration and in-memory dev-server runtime state for worktree-backed Tasks.

## Boundaries

- Persist only profile/config truth in `<projectRoot>/.termloop/devservers.json`.
- Persist setup-completion metadata only in `<projectRoot>/.termloop/devserver-setup-state.json`.
- Runtime process truth (phase, pid, URLs, log cursor, log lines) is in-memory only in `DevServerRunStore` and must never be written to `tasks.json`.
- `TaskRecord` remains a projection over `WorkspaceMetadataStore`; dev-server state is rendered through projection builders.
- `DevServerRunCoordinator` is the single writer for process lifecycle. UI and socket handlers call the coordinator rather than mutating runtime state directly.
- Launches must run inside a task/worktree cwd and must not implicitly provision a worktree.
- Browser opens are explicit user/socket intent only; passive status/list/log calls must not steal focus.

## Extensibility

The models intentionally use `RunProfileKind` and profile `extensions` so future test runners or generic run profiles can reuse the store/coordinator shape without coupling to provider-specific agent behavior.

## Project profile schema

`<projectRoot>/.termloop/devservers.json` is `schemaVersion: 1` and currently uses the Swift model field names:

- `defaults.autoOpenFirstUrl` / `defaults.logLineLimit`
- `profiles[].id`, `name`, `kind` (`dev_server`), `command`, `workingDirectory`
- `profiles[].env`
- `profiles[].setupCommand`, `cleanupCommand`, `setupPolicy`
- `profiles[].urlDetection.autoDetect`, `fallbackUrls`, `readyRegexes`
- `profiles[].presentation.autoOpenFirstUrl`
- `profiles[].extensions` for future run-profile/test-runner metadata

Setup policy values:

- `once_per_worktree_profile_config` runs setup once per worktree/profile/config hash.
- `always` runs setup before every start.
- `never` skips setup even when `setupCommand` is present.

Cleanup commands run best-effort when tasks are archived/deleted, bindings migrate/detach, or projects are removed. Cleanup must also run inside the task worktree and must not write runtime state to task persistence.

Socket responses intentionally expose stable `snake_case` fields (`working_directory`, `setup_command`, `cleanup_command`, `setup_policy`, `url_detection`, `open_on_url`, etc.). Profile mutation over sockets accepts the same `snake_case` shape and is Unix-socket-only; TCP/mobile callers may list existing profiles, start/stop/restart runs, read logs/status, inspect preview browser context, and explicitly open URLs.

`devservers.profiles.save_and_test` saves a profile, restarts it for a task, and returns both the run snapshot and a `test` summary (`waiting`, `ready`, `failed`, or `exited`). Callers that receive `waiting` should follow `devserver.url`, `devserver.status`, and `devserver.log` events for the final result.

`devservers.preview.inspect` returns the matching browser surface plus existing browser automation methods (`browser.screenshot`, `browser.eval`, `browser.console.list`, `browser.errors.list`) when a TermLoop browser preview exists; otherwise it returns a clean unsupported error.
