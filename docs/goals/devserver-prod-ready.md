# Goal: Make Dev Server workflows production-ready

Repo/worktree: /Users/feritzcan/Projects/bmadworkflowtest/.termloop-worktrees/devserver
Branch: devserver

Continue from the existing Dev Server commits. Do not reimplement the MVP from scratch. Audit what exists, fill gaps, harden behavior, and keep the implementation aligned with TermLoop architecture.

## Hard rules

- Do not stop until all phases below are complete, or a true compile blocker is reached.
- No interim reports; final report once after validation and commit.
- Run `$simplify` after every phase and apply safe local cleanup.
- Do not run local test suites. You may add/update focused tests, but do not execute them.
- Run `git diff --check` before the final build.
- Final validation: `cd termloop && ./scripts/reload.sh --tag devserver-run-profiles`.
- If build fails, fix and rerun until it passes.
- Commit completed changes after successful validation.
- Do not persist runtime process truth in `.termloop/tasks.json` or `TaskRecord`.
- Runtime process truth remains in-memory in `DevServerRunStore`.
- Profile/config truth remains project-level under `<projectRoot>/.termloop/devservers.json`.
- Setup completion metadata remains outside tasks.json under project `.termloop`.
- Localize all user-facing strings in `termloop/Resources/TermLoop.xcstrings`.
- Any agent prompt/template text must be visible/editable under Prompt Templates / Quick Action. No hidden inline prompts in code.
- Mobile UI/client work is out of scope for this goal.
- Do not modify upstream/vendor files unless absolutely required by a hook marker; prefer TermLoop-owned files.

## Objective

Turn the worktree-backed Dev Server system into a production-ready TermLoop workflow:

- users can create, edit, test, and delete run profiles from the Task UI without hand-editing JSON for common cases;
- Save & Test gives clear progress, timeout, success, failure, logs, and URL behavior;
- process cleanup is robust enough for real dev servers that spawn child processes;
- users can ask an agent to generate profiles through visible Prompt Templates / Quick Actions only;
- the architecture can support generic run profiles such as dev servers, test runners, workers, storybook, and typecheckers without duplicating lifecycle code.

## Phase 1 — Audit current implementation

- Inspect existing Dev Server files, socket commands, task/worktree lifecycle hooks, profile store, setup state store, browser integration, and UI.
- Produce an internal acceptance gap list before editing.
- Confirm no runtime state is currently written to tasks.json.
- Confirm corrupt `devservers.json` still surfaces errors and is never overwritten by profile mutation.
- Apply `$simplify` cleanup after the audit if any safe issues are found.

## Phase 2 — Production profile editor UI

Upgrade `DevServerTaskSection` from minimal draft editor to usable profile management.

Required UX:

- Existing profile rows have an Edit action.
- Editing an existing profile pre-fills the form.
- Users can create a new profile.
- Users can delete a profile with a safe confirmation affordance.
- Form fields cover common schema:
  - `id`
  - `name`
  - `kind`
  - `command`
  - `workingDirectory`
  - environment variables as key/value rows
  - fallback URLs as editable rows
  - setup command
  - cleanup command
  - setup policy dropdown: once per worktree/profile/config, always, never
  - auto-open first URL toggle
- Keep “Open config” fallback visible for advanced JSON edits.
- If config is corrupt, show error and do not allow save/delete mutation that would overwrite user config.
- Validate profile id/name/command/cwd in the UI and show localized errors.
- Keep UI compact enough for the Task sidebar.
- Do not introduce hidden prompt strings.
- Apply `$simplify` at phase end.

Acceptance:

- Create/edit/delete profiles works from Task detail sidebar.
- Existing profiles round-trip through UI without losing env/fallback/setup/cleanup/presentation fields.
- Corrupt config cannot be overwritten from the UI.
- Empty/invalid fields show clear localized validation.

## Phase 3 — Save & Test production UX

Make Save & Test feel deterministic and debuggable.

Required behavior:

- Save & Test saves the profile, starts/restarts the run, runs setup when needed, then tracks result asynchronously in UI.
- UI shows explicit states:
  - saving
  - setup running
  - starting
  - waiting for URL
  - ready with URL
  - failed with error
  - exited before URL
  - timed out waiting for URL
- Add a reasonable timeout for URL detection/fallback readiness. Do not block the main actor.
- Show the latest URL and “Open” action when ready.
- Show first relevant error / latest stderr when failed.
- Show “Logs” shortcut from the Save & Test result.
- Socket `devservers.profiles.save_and_test` should return a stable snake_case payload with:
  - saved profile
  - run snapshot
  - test status
  - URL if already available
  - error if already failed
  - event types clients should follow for async completion
- If sync socket architecture cannot wait without blocking, do not block; document and expose follow-up event/poll contract clearly.
- Apply `$simplify` at phase end.

Acceptance:

- User can understand Save & Test progress without opening logs.
- Failures show actionable command/setup stderr.
- Timeout is visible and does not kill the run unless user stops it.
- Socket response is stable snake_case and provider-neutral.

## Phase 4 — Process cleanup hardening

Harden stop/restart/archive/delete cleanup for real dev servers.

Required work:

- Audit `DevServerProcessRunner` and process group behavior on macOS.
- Improve process group setup if possible without destabilizing launch.
- Ensure stop sends graceful termination then force kill to the whole process group when available.
- Track whether process-group setup succeeded and expose this in logs or debug payloads if useful.
- On restart, avoid immediate port reuse races where feasible.
- Add best-effort port release verification for local detected/fallback URLs:
  - after stop/restart, detect if the local port still appears occupied;
  - surface a warning in logs/UI/socket payload rather than crashing.
- Prevent stale process-exit callbacks from overwriting newer run state.
- Ensure cleanup commands are not killed immediately by project removal logic.
- Keep cleanup best-effort and bounded; do not block UI indefinitely.
- Apply `$simplify` at phase end.

Acceptance:

- Stop/restart releases typical Vite/Next/Python static server ports.
- Archive/delete/unbind/migration stops active runs and runs cleanup when configured.
- If port is still occupied after stop, user sees a clear warning.
- No false failed state from intentional user stop.
- No runtime process truth in tasks.json.

## Phase 5 — Agent profile generation workflow

Use the existing visible Prompt Template foundation to add a user-facing generation flow.

Required behavior:

- Add a visible UI entry point near Dev Servers: “Generate profile with agent” or equivalent.
- The flow must use a visible Prompt Template / Quick Action template. No inline hidden prompt text.
- If a prompt template already exists, reuse it; otherwise add/edit visible template records only.
- The generated request should guide the agent to inspect project files and propose/update `.termloop/devservers.json`.
- The flow should preserve existing profiles and avoid unsafe commands unless user confirms.
- Generated profiles should prefer localhost-bound commands and safe browser behavior.
- If direct agent launching from this UI is too large, add a clearly wired Quick Action/template entry and document the next click path.
- Apply `$simplify` at phase end.

Acceptance:

- User can discover profile generation from Dev Servers UI.
- Prompt/template content is visible/editable in Prompt Templates or Quick Action UI.
- No hidden prompt text is embedded in code.
- Flow targets project-level `.termloop/devservers.json`.

## Phase 6 — General Run Profiles foundation

Generalize the architecture enough to support more than dev servers without duplicating the lifecycle.

Required behavior:

- Keep existing `dev_server` profiles working exactly as before.
- Extend model/UI naming carefully so future kinds are possible:
  - `dev_server`
  - `test_runner`
  - `worker`
  - `storybook`
  - `typecheck`
  - or a clear generic/custom kind if better.
- Avoid broad rewrites. Prefer additive model support and naming abstractions.
- UI may continue to live under Dev Servers for now, but profile kind should be visible/editable.
- Socket profile payloads must include stable snake_case `kind`.
- Lifecycle coordinator should remain provider-neutral and reusable.
- Tests should cover profile kind decoding/round-trip where practical.
- Update docs to explain how non-dev-server run profiles fit.
- Apply `$simplify` at phase end.

Acceptance:

- Existing `dev_server` JSON still decodes and runs.
- New supported kinds can be saved/loaded and shown in UI.
- Lifecycle logic does not fork into duplicated code paths per kind.
- Socket payloads remain stable.

## Phase 7 — Docs, tests, localization, final audit

- Update `termloop/Sources/TermLoop/DevServers/CLAUDE.md` with:
  - profile schema
  - setup/cleanup
  - Save & Test contract
  - process cleanup semantics
  - agent generation flow
  - generic run profile kinds
  - socket contract
- Add/update focused tests for pure logic only; do not run them:
  - profile model/store round-trip with env/fallback/setup/cleanup/kind
  - setup-state hash behavior
  - URL/port helper pure logic where practical
  - socket payload decode helpers where practical
- Localize every new user-facing string.
- Run `$simplify` one final time.
- Run `git diff --check`.
- Run `cd termloop && ./scripts/reload.sh --tag devserver-run-profiles`.
- Fix build failures and rerun until successful.
- Commit the final changes.

## Final report required

Report only after commit:

- commit SHA
- phases completed
- key files changed
- validation commands and results
- manual smoke checklist to run next
- residual risks, especially around macOS process groups and unsupported browser automation cases
