# Sync Workflow

Pulling upstream (`feritzcan2/termloop`) into `termloop` is standardized as the
`/sync-upstream` slash command.

## Steps

1. **Preconditions:** clean working tree, on `master`, submodules reconciled first
   via `/sync-branch` if needed.
2. **Backup tag:** `git tag "backup/pre-sync-$(date +%Y-%m-%d-%H%M)"`.
3. **Fetch upstream:** `git fetch upstream --tags`.
4. **Rebase:** `git rebase upstream/main`.
5. **Conflict triage** — see table below.
6. **Build check:** `xcodebuild -project GhosttyTabs.xcodeproj -scheme termloop -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/termloop-post-sync build`.
7. **Push:** `git push origin master --force-with-lease`.
8. **Report:** upstream commits consumed, conflicts resolved, build result.

## Conflict triage table

| Conflict location | Resolution policy |
|---|---|
| `Sources/TermLoop/**` | Ours wins. Upstream shouldn't touch this dir; if it does, investigate manually. |
| Upstream file, inside `// MARK: termloop-hook` block | Ours wins. Marker block is ours by contract. |
| Upstream file, outside marker block | Upstream wins. Our stray change is a bug — relocate to `Sources/TermLoop/`, then finish rebase. |
| `Resources/Localizable.xcstrings` | Upstream wins. Custom keys must live in `Resources/TermLoop.xcstrings`; relocate any leakage. |
| Submodule pointer | Apply existing submodule workflow from `termloop/CLAUDE.md` (§ "Ghostty submodule workflow"). |
| None of the above | Stop. Ask the maintainer. |

## Cadence

- **Weekly** `/sync-upstream` is the baseline. Small, frequent syncs keep conflicts small.
- Ad-hoc sync when upstream ships a critical fix.

## Rollback

If anything fails or the user decides to abort post-rebase:

```bash
git reset --hard backup/pre-sync-YYYY-MM-DD-HHMM
git push origin master --force-with-lease
```

Backup tags are never deleted.
