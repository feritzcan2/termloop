# WorktreeSetup Area Rules

This folder owns **Local setup**: project-scoped preparation that can run once per task worktree before run profiles, tests, or other local workflows.

- Persist config only in `<projectRoot>/.termloop/worktree-setup.json`.
- Persist completion/skip metadata only in `<projectRoot>/.termloop/worktree-setup-state.json`.
- Do not write runtime process truth into `.termloop/tasks.json`.
- User-facing name is **Local setup**. `WorktreeSetup` is the internal API name.
- Local setup is project-scope and once-per-worktree/config. DevServer `setupCommand` remains profile-scope and per profile/config.
- Do not auto-run on worktree creation. Run lazily when a profile declares `requiresLocalSetup`, or when the user explicitly runs Local setup.
- Agent generation must use visible Prompt Templates / Quick Action templates only. Use `local-setup-generator` with `system.template.local-setup-generator`; do not embed hidden prompts in Swift code.
