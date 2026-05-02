# termloop agent notes

Terminal-agent presentation work must follow the architecture in `CLAUDE.md`: `TerminalAgentActivityStore` is the source of truth, query logic lives next to it, formatting stays separate, and `TerminalAgentActivityResolver` must not come back.

## Git workflow (termloop)

`termloop/` now lives as a normal tracked directory inside the parent repo. Default: commit in the parent repo branch you are working on. There is no separate nested remote to push from inside `termloop/`. If you need fresh upstream code for `termloop`, `ghostty`, `homebrew-cmux`, or `bonsplit`, run `../scripts/sync-upstreams.sh` from `termloop/` or `./scripts/sync-upstreams.sh` from the repo root. Skip ticket skills (`ticket-start`, `ticket-dev-pr`, `ticket-promote`) unless invoked by name. Tests and the pre-commit discipline hook still run — flattening the repo does not mean skipping safety checks.

## TermLoop fork discipline

`termloop` is maintained as a product (`termloop`) on top of upstream
`feritzcan2/termloop`. Everything we add must be isolated so upstream syncs stay
conflict-free.

### K-Rules (Keep)

- **K1:** New Swift files go under `Sources/TermLoop/<subfolder>/`. Never
  directly under `Sources/`. CLI code under `CLI/TermLoop/`.
- **K2:** No new functions, methods, or properties inside upstream file
  bodies. Use Swift extensions in `Sources/TermLoop/Hooks/`.
- **K3:** Upstream files may only contain single-line hook calls wrapped in
  `// MARK: termloop-hook` / `// MARK: /termloop-hook` marker blocks. Marker
  counts must balance.
- **K4:** Custom localization keys go in `Resources/TermLoop.xcstrings`,
  accessed via `String(localized: "key", defaultValue: "...", table: "TermLoop")`.
  `Resources/Localizable.xcstrings` stays upstream-only.

### Y-Rules (Yasak — prohibitions)

- **Y1:** No multi-line blocks inside an upstream function body. Delegate to a
  single `TermLoopHooks.xxx(...)` call.
- **Y2:** Don't rename upstream variables or parameters.
- **Y3:** Don't add new `if`/`else`/`switch` branches to upstream control
  flow. Decide inside the hook.
- **Y4:** No stored properties added to upstream class bodies. Use
  `WorkspaceMetadataStore` pattern.

### Operational

- **Pulling upstream:** `/sync-upstream` slash command (weekly cadence).
- **Exceptions** to any rule require an `termloop-exception: <reason>` commit
  trailer and an entry in `docs/termloop/exceptions.md`.
- **Discipline tooling:** run `scripts/install-termloop.sh` once per clone to
  enable the pre-commit hook (`.githooks/pre-commit`) and the `merge=ours`
  driver declared in `.gitattributes`. CI re-runs the same check on every PR
  (`.github/workflows/termloop-discipline.yml`). After touching any upstream
  file, regenerate `docs/termloop/hooks-inventory.md` via
  `python3 scripts/generate-hooks-inventory.py`.

Deep-dive references (read when the summary isn't enough):

- `docs/termloop/isolation-rules.md` — full K/Y text + exception mechanism.
- `docs/termloop/hook-patterns.md` — the 4 permitted hook shapes + examples.
- `docs/termloop/hooks-inventory.md` — every marker block currently in the tree.
- `docs/termloop/xcstrings-setup.md` — Xcode wiring for the TermLoop string table.
- `docs/termloop/sync-workflow.md` — conflict triage + rollback steps.
- `docs/termloop/project-layer.md` — Project feature architecture.

## Terminal-agent presentation architecture

Terminal-agent UI state now has a fixed ownership model. Keep using it.

- **Source of truth:** `Sources/TermLoop/Core/TerminalAgentActivityStore.swift`
- **Truth/query helpers:** `Sources/TermLoop/Core/TerminalAgentActivityStore+Queries.swift`
- **Formatting helpers only:** `Sources/TermLoop/Core/TerminalAgentDisplayFormatting.swift`
- **Status-key helpers only:** `Sources/TermLoop/Core/TerminalAgentStatusKeys.swift`
- **Removed on purpose:** `TerminalAgentActivityResolver.swift`

Rules:

- Do not create or reintroduce a resolver/facade layer for terminal-agent presentation.
- UI/panels/rows should read `TerminalAgentActivityStore` presentation/query APIs, not raw activity state, `workspace.statusEntries`, `workspace.agentPIDs`, or ad-hoc metadata chains to derive terminal-agent presentation.
- Prefer parent-built snapshots and pure row renderers over row-local truth resolution.
- If logic changes truth or visibility, put it in the store/query layer. If logic only changes text/labels/icons, put it in formatting helpers.
- Keep selection state, elapsed timers, and other pure UI concerns outside the store.

## Initial setup

Run the setup script to verify vendored dependencies are present and build GhosttyKit:

```bash
./scripts/setup.sh
```

## Local dev

After making code changes, always run the reload script with a tag to build the Debug app:

```bash
./scripts/reload.sh --tag fix-zsh-autosuggestions
```

By default, `reload.sh` builds but does **not** launch the app. The script prints the `.app` path so the user can cmd-click to open it. Pass `--launch` to kill any existing instance and open the app automatically:

```bash
./scripts/reload.sh --tag fix-zsh-autosuggestions --launch
```

`reload.sh` prints an `App path:` line with the absolute path to the built `.app`. Use that path to build a cmd-clickable `file://` URL. Steps:

1. Grab the path from the `App path:` line in `reload.sh` output.
2. Prepend `file://` and URL-encode spaces as `%20`. Do not hardcode any part of the path.
3. Format it as a markdown link using the template for your agent type.

Example. If `reload.sh` output contains:
```
App path:
  /Users/someone/Library/Developer/Xcode/DerivedData/termloop-my-tag/Build/Products/Debug/TermLoop DEV my-tag.app
```

**Claude Code** outputs:
```markdown
=======================================================
[TermLoop DEV my-tag.app](file:///Users/someone/Library/Developer/Xcode/DerivedData/termloop-my-tag/Build/Products/Debug/termloop%20DEV%20my-tag.app)
=======================================================
```

**Codex** outputs:
```
=======================================================
[my-tag: file:///Users/someone/Library/Developer/Xcode/DerivedData/termloop-my-tag/Build/Products/Debug/termloop%20DEV%20my-tag.app](file:///Users/someone/Library/Developer/Xcode/DerivedData/termloop-my-tag/Build/Products/Debug/termloop%20DEV%20my-tag.app)
=======================================================
```

Never use `/tmp/termloop-<tag>/...` app links in chat output.

After making code changes, always use `reload.sh --tag` to build. **Never run bare `xcodebuild` or `open` an untagged `TermLoop DEV.app`.** Untagged builds share the default debug socket and bundle ID with other agents, causing conflicts and stealing focus.

```bash
./scripts/reload.sh --tag <your-branch-slug>
```

If you only need to verify the build compiles (no launch), use a tagged derivedDataPath:

```bash
xcodebuild -project GhosttyTabs.xcodeproj -scheme termloop -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/termloop-<your-tag> build
```

When rebuilding GhosttyKit.xcframework, always use Release optimizations:

```bash
cd ghostty && zig build -Demit-xcframework=true -Dxcframework-target=universal -Doptimize=ReleaseFast
```

When rebuilding cmuxd for release/bundling, always use ReleaseFast:

```bash
cd cmuxd && zig build -Doptimize=ReleaseFast
```

`reload` = build the Debug app (tag required). Pass `--launch` to also kill existing and open:

```bash
./scripts/reload.sh --tag <tag>
./scripts/reload.sh --tag <tag> --launch
```

`reloadp` = kill and launch the Release app:

```bash
./scripts/reloadp.sh
```

`reloads` = kill and launch the Release app as "TermLoop STAGING" (isolated from production cmux):

```bash
./scripts/reloads.sh
```

`reload2` = reload both Debug and Release (tag required for Debug reload):

```bash
./scripts/reload2.sh --tag <tag>
```

For parallel/isolated builds (e.g., testing a feature alongside the main app), use `--tag` with a short descriptive name:

```bash
./scripts/reload.sh --tag fix-blur-effect
```

This creates an isolated app with its own name, bundle ID, socket, and derived data path so it runs side-by-side with the main app. Important: use a non-`/tmp` derived data path if you need xcframework resolution (the script handles this automatically).

Before launching a new tagged run, clean up any older tags you started in this session (quit old tagged app + remove its `/tmp` socket/derived data).

## Debug event log

All debug events (keys, mouse, focus, splits, tabs) go to a unified log in DEBUG builds:

```bash
tail -f "$(cat /tmp/termloop-last-debug-log-path 2>/dev/null || echo /tmp/termloop-debug.log)"
```

- Untagged Debug app: `/tmp/termloop-debug.log`
- Tagged Debug app (`./scripts/reload.sh --tag <tag>`): `/tmp/termloop-debug-<tag>.log`
- `reload.sh` writes the current path to `/tmp/termloop-last-debug-log-path`
- `reload.sh` writes the selected dev CLI path to `/tmp/termloop-last-cli-path`
- `reload.sh` updates `/tmp/termloop-cli` and `$HOME/.local/bin/termloop-dev` to that CLI

- Implementation: `vendor/bonsplit/Sources/Bonsplit/Public/DebugEventLog.swift`
- Free function `dlog("message")` — logs with timestamp and appends to file in real time
- Entire file is `#if DEBUG`; all call sites must be wrapped in `#if DEBUG` / `#endif`
- 500-entry ring buffer; `DebugEventLog.shared.dump()` writes full buffer to file
- Key events logged in `AppDelegate.swift` (monitor, performKeyEquivalent)
- Mouse/UI events logged inline in views (ContentView, BrowserPanelView, etc.)
- Focus events: `focus.panel`, `focus.bonsplit`, `focus.firstResponder`, `focus.moveFocus`
- Bonsplit events: `tab.select`, `tab.close`, `tab.dragStart`, `tab.drop`, `pane.focus`, `pane.drop`, `divider.dragStart`

## Regression test commit policy

When adding a regression test for a bug fix, use a two-commit structure so CI proves the test catches the bug:

1. **Commit 1:** Add the failing test only (no fix). CI should go red.
2. **Commit 2:** Add the fix. CI should go green.

This makes it visible in the GitHub PR UI (Commits tab, check statuses) that the test genuinely fails without the fix.

## Debug menu

The app has a **Debug** menu in the macOS menu bar (only in DEBUG builds). Use it for visual iteration:

- **Debug > Debug Windows** contains panels for tuning layout, colors, and behavior. Entries are alphabetical with no dividers.
- To add a debug toggle or visual option: create an `NSWindowController` subclass with a `shared` singleton, add it to the "Debug Windows" menu in `Sources/cmuxApp.swift`, and add a SwiftUI view with `@AppStorage` bindings for live changes.
- When the user says "debug menu" or "debug window", they mean this menu, not `defaults write`.

## Pitfalls

- **Custom UTTypes** for drag-and-drop must be declared in `Resources/Info.plist` under `UTExportedTypeDeclarations` (e.g. `com.splittabbar.tabtransfer`, `com.termloop.sidebar-tab-reorder`).
- Do not add an app-level display link or manual `ghostty_surface_draw` loop; rely on Ghostty wakeups/renderer to avoid typing lag.
- **Typing-latency-sensitive paths** (read carefully before touching these areas):
  - `WindowTerminalHostView.hitTest()` in `TerminalWindowPortal.swift`: called on every event including keyboard. All divider/sidebar/drag routing is gated to pointer events only. Do not add work outside the `isPointerEvent` guard.
  - `TabItemView` in `ContentView.swift`: uses `Equatable` conformance + `.equatable()` to skip body re-evaluation during typing. Do not add `@EnvironmentObject`, `@ObservedObject` (besides `tab`), or `@Binding` properties without updating the `==` function. Do not remove `.equatable()` from the ForEach call site. Do not read `tabManager` or `notificationStore` in the body; use the precomputed `let` parameters instead.
  - `TerminalSurface.forceRefresh()` in `GhosttyTerminalView.swift`: called on every keystroke. Do not add allocations, file I/O, or formatting here.
- **Terminal find layering contract:** `SurfaceSearchOverlay` must be mounted from `GhosttySurfaceScrollView` in `Sources/GhosttyTerminalView.swift` (AppKit portal layer), not from SwiftUI panel containers such as `Sources/Panels/TerminalPanelView.swift`. Portal-hosted terminal views can sit above SwiftUI during split/workspace churn.
- **Submodule safety:** When modifying a submodule (ghostty, vendor/bonsplit, etc.), always push the submodule commit to its remote `main` branch BEFORE committing the updated pointer in the parent repo. Never commit on a detached HEAD or temporary branch — the commit will be orphaned and lost. Verify with: `cd <submodule> && git merge-base --is-ancestor HEAD origin/main`.
- **All user-facing strings must be localized.** Use `String(localized: "key.name", defaultValue: "English text")` for every string shown in the UI (labels, buttons, menus, dialogs, tooltips, error messages). Keys go in `Resources/Localizable.xcstrings` with translations for all supported languages (currently English and Japanese). Never use bare string literals in SwiftUI `Text()`, `Button()`, alert titles, etc.
- **Shortcut policy:** Every new cmux-owned keyboard shortcut must be added to `KeyboardShortcutSettings`, visible/editable in Settings, supported in `~/.config/termloop/settings.json`, and documented in the keyboard shortcut and configuration docs.
- **`SettingsCardRow` configurationReview:** `.init` runs `configurationReview.validate()`, which `precondition`s that every `.json("key")` is in `CmuxSettingsFileStore.supportedSettingsJSONPaths`. Unregistered paths crash Settings on render. Use `.settingsOnly` for UI-only toggles not surfaced in `settings.json`.
- **TCP bridge / mobile pairing:** `TermLoopTCPBridge` runs alongside the Unix listener (configured via `socketControl.tcpPort` / `socketControl.tcpBindAll` defaults or `TERMLOOP_SOCKET_TCP_*` env). TCP clients have no peer PID, so the bridge refuses non-password/non-open access modes before `handleClient`. `Connect Mobile` enables password mode, starts the bridge on `:7878`, and shows a short-lived QR token. Claimed mobile devices get a persistent access token stored as a SHA-256 hash in `~/Library/Application Support/termloop/mobile-devices.json`; tokens do not expire after pairing and remain valid until revoked. Pairing tokens are memory-only and expire quickly. The device store backs up corrupt JSON to `mobile-devices.corrupt-<timestamp>.json`, prunes old revoked devices, and lets re-pairing update an existing `device_id` instead of creating duplicates.
- **Mobile surface streaming:** mobile clients use `surface.subscribe { workspace_id, surface_id?, format?, history_lines? }` and receive pushed `surface.snapshot` / `surface.output` / `surface.closed` / `surface.error` NDJSON events on the same TCP socket. `format: "vt"` returns ANSI/VT-styled scrollback; `history_lines` defaults backend-side for mobile and is capped. Polling via `surface.read_text` remains the fallback.

## Performance discipline (Swift / SwiftUI)

Five anti-patterns fixed in `commit 84835612` — don't reintroduce. Reference that commit for working examples.

- **No recursive `filter { $0.parentId == X }` in tree walks.** Build `Dictionary(grouping:by:)` once, pass it down. Sidebar was O(n²) in folder count.
- **Memoize derived collections in SwiftUI bodies.** `Equatable` signature + memo object keyed by every input the builder reads. Don't rebuild grouped/sorted/filtered data inline in `body`. See `ActiveAgentsPanel*` memo pattern.
- **Pass closures, not eager values,** when the child uses the value conditionally (tap, popover, menu). `foo: expensive()` → `fooProvider: { expensive() }`.
- **Revision-keyed cache on `ObservableObject` derived state.** Every `@Published` input feeding a cache needs `didSet { invalidateCache() }`; cache is `(revision, value)`. Forgetting the `didSet` returns stale data — worse than no cache. See `Workspace.sidebarOrderedPanelIds()`.
- **Split panel files by concern before optimizing.** Don't add memos to 1000+ line files — the signature will miss inputs. Split by Data / Formatting / Interactions / Rows / State / View with a shared prefix, then profile.

## Git infrastructure

All git invocations route through `Sources/TermLoop/Git/GitCommandRunner` —
do not spawn `Process()` for git directly. The runner suppresses optional
locks for reads, bounds pipe drains with a timeout, and broadcasts mutation
invalidation events so the UI refreshes without manual prodding.

Hard rules:

- **Never block the main thread on git.** Restore/startup/terminal-surface/
  SwiftUI body code must use `WorkspaceMetadataStore.Metadata.worktreePath`
  as the physical checkout source, with pure-path fallback
  (`WorktreeResolver.path` + `FileManager.fileExists`, direct `.git/HEAD`
  reads). Canonical shape: `Workspace.agentLoopSpawnCwd()` /
  `Workspace.agentLoopPresentationCwd()`. We've shipped a main-thread-on-git
  regression twice; don't ship a third.
- **Raw `Process()` (only when `GitCommandRunner` doesn't fit):** close
  parent write ends after `run()`, set `terminationHandler` before `run()`,
  use `FileHandle.nullDevice` for streams you don't read, and bound every
  wait with a timeout. `GitHostAuthResolver.runCommand` is the canonical
  example.

See `Sources/TermLoop/Git/CLAUDE.md` for full rationale, the auth ladder,
and the worktree path convention.

## Test quality policy

- Do not add tests that only verify source code text, method signatures, AST fragments, or grep-style patterns.
- Do not add tests that read checked-in metadata or project files such as `Resources/Info.plist`, `project.pbxproj`, `.xcconfig`, or source files only to assert that a key, string, plist entry, or snippet exists.
- Tests must verify observable runtime behavior through executable paths (unit/integration/e2e/CLI), not implementation shape.
- For metadata changes, prefer verifying the built app bundle or the runtime behavior that depends on that metadata, not the checked-in source file.
- If a behavior cannot be exercised end-to-end yet, add a small runtime seam or harness first, then test through that seam.
- If no meaningful behavioral or artifact-level test is practical, skip the fake regression test and state that explicitly.

## Socket command threading policy

- Do not use `DispatchQueue.main.sync` for high-frequency socket telemetry commands (`report_*`, `ports_kick`, status/progress/log metadata updates).
- For telemetry hot paths:
  - Parse and validate arguments off-main.
  - Dedupe/coalesce off-main first.
  - Schedule minimal UI/model mutation with `DispatchQueue.main.async` only when needed.
- Commands that directly manipulate AppKit/Ghostty UI state (focus/select/open/close/send key/input, list/current queries requiring exact synchronous snapshot) are allowed to run on main actor.
- If adding a new socket command, default to off-main handling; require an explicit reason in code comments when main-thread execution is necessary.

## Socket focus policy

- Socket/CLI commands must not steal macOS app focus (no app activation/window raising side effects).
- Only explicit focus-intent commands may mutate in-app focus/selection (`window.focus`, `workspace.select/next/previous/last`, `surface.focus`, `pane.focus/last`, browser focus commands, and v1 focus equivalents).
- All non-focus commands should preserve current user focus context while still applying data/model changes.

## Testing policy

**Never run tests locally.** All tests (E2E, UI, python socket tests) run via GitHub Actions or on the VM.

- **E2E / UI tests:** trigger via `gh workflow run test-e2e.yml` (see cmuxterm-hq CLAUDE.md for details)
- **Unit tests:** `xcodebuild -scheme termloop-unit` is safe (no app launch), but prefer CI
- **Python socket tests (tests_v2/):** these connect to a running termloop instance's socket. Never launch an untagged `TermLoop DEV.app` to run them. If you must test locally, use a tagged build's socket (`/tmp/termloop-debug-<tag>.sock`) with `TERMLOOP_SOCKET=/tmp/termloop-debug-<tag>.sock`
- **Never `open` an untagged `TermLoop DEV.app`** from DerivedData. It conflicts with the user's running debug instance.

## Ghostty vendor workflow

`ghostty/` is a vendored directory inside the parent repo, not a nested git repo.
Keep `docs/ghostty-fork.md` up to date with any fork changes and conflict notes.

Recommended flow:

```bash
# In a separate clone of feritzcan2/ghostty:
git checkout -b <branch>
git add <files>
git commit -m "..."
git push origin <branch>

# Then in the parent repo:
./scripts/sync-upstreams.sh ghostty
git add ../upstreams.lock ghostty docs/ghostty-fork.md
git commit -m "vendor(ghostty): sync fork snapshot"
```

## Release

Use the `/release` command to prepare a new release. This will:
1. Determine the new version (bumps minor by default)
2. Gather commits since the last tag and update the changelog
3. Update `CHANGELOG.md` (the docs changelog page at `web/app/docs/changelog/page.tsx` reads from it)
4. Run `./scripts/bump-version.sh` to update both versions
5. Commit, run `./scripts/release-pretag-guard.sh`, tag, and push

Version bumping:

```bash
./scripts/bump-version.sh          # bump minor (0.15.0 → 0.16.0)
./scripts/bump-version.sh patch    # bump patch (0.15.0 → 0.15.1)
./scripts/bump-version.sh major    # bump major (0.15.0 → 1.0.0)
./scripts/bump-version.sh 1.0.0    # set specific version
```

This updates both `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` (build number). The build number is auto-incremented and is required for Sparkle auto-update to work.

Before creating a release tag, run:

```bash
./scripts/release-pretag-guard.sh
```

If it fails, run `./scripts/bump-version.sh`, commit the build-number bump, then retry tagging.

Manual release steps (if not using the command):

```bash
./scripts/release-pretag-guard.sh
git tag vX.Y.Z
git push origin vX.Y.Z
gh run watch --repo feritzcan2/termloop
```

Notes:
- Requires GitHub secrets: `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- The release asset is `termloop-macos.dmg` attached to the tag.
- README download button points to `releases/latest/download/termloop-macos.dmg`.
- Versioning: bump the minor version for updates unless explicitly asked otherwise.
- Changelog: update `CHANGELOG.md`; docs changelog is rendered from it.
