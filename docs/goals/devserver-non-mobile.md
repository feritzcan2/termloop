# Goal: Complete non-mobile Dev Server system

Repo/worktree: /Users/feritzcan/Projects/bmadworkflowtest/.termloop-worktrees/devserver
Branch: devserver

Continue from the existing dev-server MVP commit. Do not duplicate the implementation; audit it, fill gaps, and harden it.

Hard rules:
- Do not stop until all phases below are complete or a true compile blocker is reached.
- No interim reports. Final report once.
- Run `$simplify` after every phase and apply safe local cleanup.
- Do not run local test suites. You may add/update tests, but do not execute them.
- Run `git diff --check`.
- Final validation: `cd termloop && ./scripts/reload.sh --tag devserver-run-profiles`.
- If build fails, fix and rerun.
- Do not persist runtime process truth in `.termloop/tasks.json` or `TaskRecord`.
- Localize all user-facing strings in `termloop/Resources/TermLoop.xcstrings`.
- Any agent prompt/template text must be visible in Prompt Templates / Quick Action. No hidden inline prompts.
- Mobile UI/client work is out of scope.

Goal:
Build a Vibe Kanban-like, worktree-backed Dev Server system where each TermLoop Task/worktree can configure, setup, run, preview, inspect, and cleanup dev-server profiles safely.

Phase 1 — Core run system audit/hardening:
- Project-level config at `<projectRoot>/.termloop/devservers.json`.
- Store schema/default validation and corrupt-file error surfacing.
- Process runner cwd inside task worktree.
- Start/stop/restart lifecycle.
- stdout/stderr bounded log ring buffer.
- localhost URL detection/dedupe/normalization.
- Fallback URL support.
- In-memory run status only.
- Socket API: profile list/upsert/delete, start/stop/restart, runs/logs, open_url.
- Unix socket can mutate profiles; TCP/remote cannot.

Phase 2 — Task/worktree integration:
- Task detail Dev Server section.
- Task card status chip/projection.
- Project activation/status projection refresh.
- Stop active runs when task is archived/deleted.
- Stop or safely relaunch active runs when task worktree binding/path changes.
- Stop active runs when project folder changes/deletes/closes.
- Stop active runs when bound workspace/worktree closes or tears down where hooks exist.
- Start fails clearly if task has no ready worktree or cwd escapes worktree root.

Phase 3 — Preview and inspection:
- Auto-open detected/fallback local URL only when profile/default asks for it.
- Open URL in existing TermLoop browser split.
- Show latest URL in sidebar/card.
- Add console/error projection from recent stderr/recent errors.
- Add browser preview inspection hooks where existing browser automation supports screenshot/capture or JS/eval.
- If unsupported, report unsupported cleanly.
- Keep hooks provider-neutral.

Phase 4 — Setup/Cleanup + Save & Test:
- Extend profile schema for optional setup command and cleanup command.
- Add setup run policy: once per worktree/profile/config hash.
- Persist setup completion metadata outside tasks.json under project `.termloop`.
- Run setup before dev-server start when needed.
- Setup failure blocks start and shows logs/error.
- Cleanup command runs on archive/delete/worktree teardown where safe.
- Add Save & Test flow:
  - save profile
  - optionally run setup
  - start dev server
  - wait for detected/fallback URL or process failure
  - show result in UI/socket
- If full editor UI is too large, add minimal visible UI for common profile fields + Save & Test; keep Open Config fallback.

Phase 5 — Agent/profile generation:
- Add visible Prompt Template / Quick Action template for generating `.termloop/devservers.json` profiles from project inspection.
- Prompt must be visible/editable under Prompt Templates/Quick Action.
- UI may launch that template but must not embed hidden prompt text inline.
- Output targets project-level config and avoids unsafe commands unless user confirms.

Phase 6 — Polish/docs/tests:
- Update DevServers/CLAUDE.md with schema, lifecycle, setup/cleanup, socket contract.
- Add/update focused tests for pure logic:
  - URL detector
  - profile store/schema
  - setup state/config hash
  - socket payload decoding where practical
- Do not run tests locally.
- Localize all new strings.
- Run `$simplify`.

Acceptance:
- Project config profile appears in selected worktree-backed task.
- Start runs inside task worktree cwd.
- Setup runs once per worktree/profile/config hash before start.
- Setup failure blocks start and shows logs/error.
- Stop/restart releases port.
- Archive/delete/worktree teardown triggers stop and cleanup where configured.
- stdout/stderr appears in UI logs and socket events.
- stderr/recent errors projected in task UI.
- Localhost/fallback URL shown and openable in browser split.
- Browser preview hook works if supported, else clean unsupported error.
- Socket API stable snake_case.
- Corrupt config never crashes or overwrites user config.
- No runtime process truth in tasks.json.
- Final reload build succeeds.

Final actions:
- Run `git diff --check`.
- Run `cd termloop && ./scripts/reload.sh --tag devserver-run-profiles`.
- Commit completed changes if build succeeds.
- Final report: phases completed, files changed, validation results, manual smoke steps, residual risks.
