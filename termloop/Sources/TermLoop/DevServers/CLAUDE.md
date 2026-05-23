# TermLoop DevServers — Agent Context

This folder owns project-scoped run profile configuration and in-memory runtime state for worktree-backed Task run profiles. The UI still presents the section as “Dev Servers”, but the model/lifecycle is intentionally reusable for dev servers, test runners, workers, Storybook, and typecheckers.

## Boundaries

- Persist only profile/config truth in `<projectRoot>/.termloop/devservers.json`.
- Persist setup-completion metadata only in `<projectRoot>/.termloop/devserver-setup-state.json`.
- Project-wide Local setup lives separately in `<projectRoot>/.termloop/worktree-setup.json` and is owned by `WorktreeSetup`.
- Runtime process truth (phase, pid, process group, URLs, log cursor, log lines, warnings) is in-memory only in `DevServerRunStore` and must never be written to `tasks.json`.
- `TaskRecord` remains a projection over `WorkspaceMetadataStore`; dev-server state is rendered through projection builders.
- `DevServerRunCoordinator` is the single writer for process lifecycle. UI and socket handlers call the coordinator rather than mutating runtime state directly.
- Launches must run inside a task/worktree cwd and must not implicitly provision a worktree.
- Browser opens are explicit user/socket intent only; passive status/list/log calls must not steal focus.
- Profile mutation over sockets is Unix-socket-only. TCP/mobile callers may operate existing profiles but must not write arbitrary shell commands.

## Project profile schema

`<projectRoot>/.termloop/devservers.json` is `schemaVersion: 1` and currently uses the Swift model field names:

- `defaults.autoOpenFirstUrl` / `defaults.logLineLimit`
- `profiles[].id`, `name`, `kind`, `command`, `workingDirectory`
- `profiles[].env`
- `profiles[].setupCommand`, `cleanupCommand`, `setupPolicy`
- `profiles[].requiresLocalSetup`
- `profiles[].urlDetection.autoDetect`, `fallbackUrls`, `readyRegexes`
- `profiles[].presentation.autoOpenFirstUrl`
- `profiles[].extensions` for future run-profile/test-runner metadata

Supported `kind` values:

- `dev_server`
- `test_runner`
- `worker`
- `storybook`
- `typecheck`

The coordinator does not branch lifecycle behavior by kind. Kinds are user-facing metadata plus future extension points; avoid duplicating process lifecycle code per kind.

Setup policy values:

- `once_per_worktree_profile_config` runs setup once per worktree/profile/config hash.
- `always` runs setup before every start.
- `never` skips setup even when `setupCommand` is present.

`requiresLocalSetup` means the profile should run project-scope Local setup first when `.termloop/worktree-setup.json` exists and is pending for the task worktree. Keep the distinction clear:

- Local setup (`WorktreeSetup`) is project-scope and once per worktree/config. Use it for copying ignored local config, creating local files, or shared restore/install preparation.
- `setupCommand` is profile-scope and once per worktree/profile/config. Use it only for profile-specific warmups.

Do not duplicate the same install/setup work in both layers.

Cleanup commands run best-effort when tasks are archived/deleted, bindings migrate/detach, or projects are removed. Cleanup must run inside the task worktree and must not write runtime state to task persistence.

## Save & Test contract

The Task sidebar profile editor can create, edit, delete, and Save & Test common profile fields without hand-editing JSON. Advanced JSON editing remains available through Open Config.

Save & Test:

1. validates and saves the profile;
2. restarts the selected task/profile run;
3. runs setup first when policy requires it;
4. tracks the run asynchronously for ready URL, failure, exit-before-URL, or timeout;
5. does not block the main actor and does not kill the run on timeout.

`devservers.profiles.save_and_test` returns a stable snake_case payload containing `profile`, `run`, and `test`. If `test.status` is `starting`, `setup_running`, or `waiting_for_url`, clients should follow `devserver.url`, `devserver.status`, and `devserver.log` events or poll `devservers.runs.list` / `devservers.logs`.

## Process cleanup semantics

`DevServerProcessRunner` launches commands through the user shell and attempts to place the launched shell in its own process group. Stop sends SIGTERM, then SIGKILL after a grace period, targeting the process group when available. If process-group setup fails, a system log warning is emitted and stop falls back to the shell process.

After stop, the coordinator performs best-effort local port checks for detected/fallback localhost URLs. If a port still accepts localhost connections, it appends a warning log line; this is diagnostic only and must not crash or overwrite task state. Restart force-stops the previous run, waits briefly for port release, and skips old-run port warnings when a replacement run for the same key is already active.

## Browser preview / inspection

`devservers.preview.inspect` returns the matching browser surface plus existing browser automation methods (`browser.screenshot`, `browser.eval`, `browser.console.list`, `browser.errors.list`) when a TermLoop browser preview exists; otherwise it returns a clean unsupported error.

## Agent profile generation

Profile generation must use visible Prompt Templates / Quick Action templates only. The built-in Quick Action template `devserver-profile-generator` uses the visible system prompt document `system.template.devserver-profile-generator`. Do not embed hidden prompt text in Dev Server UI code. The UI may open Quick Action preselected to that template, and users must be able to inspect/edit the template content from the normal Prompt Templates / Quick Action surfaces.

Generated profile guidance should preserve existing profiles, target project-level `.termloop/devservers.json`, prefer localhost-bound commands, and avoid setup/cleanup commands that mutate the project unless the user confirms.

## Socket contract

Socket responses intentionally expose stable `snake_case` fields (`working_directory`, `setup_command`, `cleanup_command`, `setup_policy`, `url_detection`, `open_on_url`, `process_group_established`, etc.). Profile mutation accepts the same `snake_case` shape and tolerates legacy camelCase where already supported.
