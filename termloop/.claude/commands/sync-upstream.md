# Sync Upstream

Pull `manaflow-ai/cmux` (upstream) into `termloop` via rebase.

**Never push automatically. Always ask the user before pushing.**

## Preconditions (abort if any fails)

- `git status` is clean (no uncommitted changes).
- Current branch is `master`.
- Any pending submodule changes have been reconciled via `/sync-branch`.

## Steps

1. **Backup tag**
   ```bash
   git tag "backup/pre-sync-$(date +%Y-%m-%d-%H%M)"
   ```

2. **Fetch upstream**
   ```bash
   git fetch upstream --tags
   ```
   Report: "upstream is N commits ahead" (via `git rev-list --count master..upstream/main`).

3. **Rebase**
   ```bash
   git rebase upstream/main
   ```

4. **Conflict triage** (only if rebase stops with conflicts)

   Apply the triage table from `docs/termloop/sync-workflow.md`:

   | Conflict location | Resolution |
   |---|---|
   | `Sources/TermLoop/**` | Ours wins; investigate if upstream touched it. |
   | Upstream file, inside marker block | Ours wins. |
   | Upstream file, outside marker block | Upstream wins; relocate our stray change to `Sources/TermLoop/`. |
   | `Resources/Localizable.xcstrings` | Upstream wins; relocate any TermLoop key leakage to `Resources/TermLoop.xcstrings`. |
   | Submodule pointer | Apply `termloop/CLAUDE.md` submodule workflow. |
   | Other | Stop; ask the maintainer. |

   After resolving: `git add <files> && git rebase --continue`.

5. **Build verification**
   ```bash
   xcodebuild -project GhosttyTabs.xcodeproj -scheme termloop \
     -configuration Debug -destination 'platform=macOS' \
     -derivedDataPath /tmp/termloop-post-sync build
   ```
   Expected: `** BUILD SUCCEEDED **`.

6. **Ask user before pushing**

   Report: conflict count, which triage rules fired, whether build passed, diff summary.
   Do NOT run `git push` without explicit user approval.

7. **Push (after user approval)**
   ```bash
   git push origin master --force-with-lease
   ```

## Rollback

If anything fails or the user decides to abort post-rebase:
```bash
git reset --hard backup/pre-sync-YYYY-MM-DD-HHMM
# if already pushed:
git push origin master --force-with-lease
```

Backup tags are never deleted.
