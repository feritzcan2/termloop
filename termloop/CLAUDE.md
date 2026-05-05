# termloop agent notes

`termloop/` is the product layer inside the workspace. Start here for TermLoop-wide workflow, then use the local area docs in `termloop/Sources/TermLoop/` for narrower rules. The area docs are the source of truth for Core/UI/AgentInputs/Git/AgentTerminals behavior.

## Area map

- `Sources/TermLoop/Core/CLAUDE.md` — terminal-agent presentation and shared core state
- `Sources/TermLoop/UI/CLAUDE.md` — main-area/page/portal policy
- `Sources/TermLoop/UI/Agents/CLAUDE.md` — sidebar, worktree, and agent panels
- `Sources/TermLoop/AgentInputs/CLAUDE.md` — agent launch/input composition
- `Sources/TermLoop/Git/CLAUDE.md` — git command runner, stores, and invalidation
- `Sources/TermLoop/AgentTerminals/CLAUDE.md` — terminal-agent lifecycle
- `Sources/TermLoop/Tasks/CLAUDE.md` — Task domain (single-writer coordinator, store, reconciler, ranking, store provider)
- `Sources/TermLoop/UI/Tasks/CLAUDE.md` — Tasks page UI (board, card, sidebar drill-in, projection sections)

## Git workflow (termloop)

`termloop/` now lives as a normal tracked directory inside the parent repo. Default: commit in the parent repo branch you are working on. There is no separate nested remote to push from inside `termloop/`. If you need fresh upstream code for `termloop`, `ghostty`, or `bonsplit`, run `../scripts/sync-upstreams.sh` from `termloop/` or `./scripts/sync-upstreams.sh` from the repo root. Skip ticket skills (`ticket-start`, `ticket-dev-pr`, `ticket-promote`) unless invoked by name. Tests and the pre-commit discipline hook still run — flattening the repo does not mean skipping safety checks.

## TermLoop fork discipline

`termloop` is maintained as a product (`termloop`) on top of upstream `feritzcan2/termloop`. Everything we add must be isolated so upstream syncs stay conflict-free.

### K-Rules (Keep)

- **K1:** New Swift files go under `Sources/TermLoop/<subfolder>/`. Never directly under `Sources/`. CLI code under `CLI/TermLoop/`.
- **K2:** No new functions, methods, or properties inside upstream file bodies. Use Swift extensions in `Sources/TermLoop/Hooks/`.
- **K3:** Upstream files may only contain single-line hook calls wrapped in `// MARK: termloop-hook` / `// MARK: /termloop-hook` marker blocks. Marker counts must balance.
- **K4:** Custom localization keys go in `Resources/TermLoop.xcstrings`, accessed via `String(localized: "key", defaultValue: "...", table: "TermLoop")`. `Resources/Localizable.xcstrings` stays upstream-only.

### Y-Rules (Yasak — prohibitions)

- **Y1:** No multi-line blocks inside an upstream function body. Delegate to a single `TermLoopHooks.xxx(...)` call.
- **Y2:** Don't rename upstream variables or parameters.
- **Y3:** Don't add new `if`/`else`/`switch` branches to upstream control flow. Decide inside the hook.
- **Y4:** No stored properties added to upstream class bodies. Use `WorkspaceMetadataStore` pattern.

### Operational

- **Pulling upstream:** `/sync-upstream` slash command (weekly cadence).
- **Exceptions** to any rule require an `termloop-exception: <reason>` commit trailer and an entry in `docs/termloop/exceptions.md`.
- **Discipline tooling:** run `scripts/install-termloop.sh` once per clone to enable the pre-commit hook (`.githooks/pre-commit`) and the `merge=ours` driver declared in `.gitattributes`. CI re-runs the same check on every PR (`.github/workflows/termloop-discipline.yml`). After touching any upstream file, regenerate `docs/termloop/hooks-inventory.md` via `python3 scripts/generate-hooks-inventory.py`.

Deep-dive references (read when the summary isn't enough):

- `docs/termloop/isolation-rules.md` — full K/Y text + exception mechanism.
- `docs/termloop/hook-patterns.md` — the 4 permitted hook shapes + examples.
- `docs/termloop/hooks-inventory.md` — every marker block currently in the tree.
- `docs/termloop/xcstrings-setup.md` — Xcode wiring for the TermLoop string table.
- `docs/termloop/sync-workflow.md` — conflict triage + rollback steps.
- `docs/termloop/project-layer.md` — Project feature architecture.

## Local dev

After making code changes, always run the reload script with a tag to build the Debug app:

```bash
./scripts/reload.sh --tag fix-zsh-autosuggestions
```

By default, `reload.sh` builds but does **not** launch the app. The script prints the `.app` path so the user can cmd-click to open it. Pass `--launch` to kill any existing instance and open the app automatically.

`reload.sh` prints an `App path:` line with the absolute path to the built `.app`. Use that path to build a cmd-clickable `file://` URL. Never use `/tmp/termloop-<tag>/...` app links in chat output.

After making code changes, always use `reload.sh --tag` to build. **Never run bare `xcodebuild` or `open` an untagged `TermLoop DEV.app`.** Untagged builds share the default debug socket and bundle ID with other agents, causing conflicts and stealing focus.

If you only need to verify the build compiles (no launch), use a tagged derivedDataPath:

```bash
xcodebuild -project GhosttyTabs.xcodeproj -scheme termloop -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/termloop-<your-tag> build
```

When rebuilding GhosttyKit.xcframework, always use Release optimizations. Fresh clones should normally reuse a checksum-pinned prebuilt GhosttyKit via `scripts/ensure-ghosttykit.sh`; local Zig rebuilds are the fallback when no matching prebuilt exists for the vendored `termloop/ghostty` source tree. If you change Ghostty's exported C API or any source that affects `libghostty.a`, run `scripts/publish-ghosttykit.sh` so the matching `xcframework-<ghostty-source-key>` artifact, `scripts/ghosttykit-checksums.txt`, and `upstreams.lock` `GHOSTTY_TREE_KEY` stay in sync. Use `scripts/validate-ghosttykit.sh` when checking a local or downloaded framework.

When rebuilding cmuxd for release/bundling, always use ReleaseFast.

## Debug event log

All debug events (keys, mouse, focus, splits, tabs) go to a unified log in DEBUG builds.

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

When adding a regression test for a bug fix, use a two-commit structure so CI proves the test catches the bug.

## Debug menu

The app has a **Debug** menu in the macOS menu bar (only in DEBUG builds). Use it for visual iteration.

## Pitfalls

- Do not add an app-level display link or manual `ghostty_surface_draw` loop; rely on Ghostty wakeups/renderer to avoid typing lag.
- **Typing-latency-sensitive paths**:
  - `WindowTerminalHostView.hitTest()` in `TerminalWindowPortal.swift`
  - `TabItemView` in `ContentView.swift`
  - `TerminalSurface.forceRefresh()` in `GhosttyTerminalView.swift`
- **Terminal find layering contract:** `SurfaceSearchOverlay` must be mounted from `GhosttySurfaceScrollView` in `Sources/GhosttyTerminalView.swift`.
- **All user-facing strings must be localized.** Use `String(localized: "key.name", defaultValue: "English text")` for every string shown in the UI.
- **Shortcut policy:** Every new cmux-owned keyboard shortcut must be added to `KeyboardShortcutSettings`, visible/editable in Settings, supported in `~/.config/termloop/settings.json`, and documented.
- **`SettingsCardRow` configurationReview:** `.init` runs `configurationReview.validate()`, which `precondition`s that every `.json("key")` is in `CmuxSettingsFileStore.supportedSettingsJSONPaths`.
- **TCP bridge / mobile pairing:** `TermLoopTCPBridge` runs alongside the Unix listener.
- **Mobile surface streaming:** mobile clients use `surface.subscribe { workspace_id, surface_id?, format?, history_lines? }`.

## Performance discipline (Swift / SwiftUI)

Five anti-patterns fixed in `commit 84835612` — don't reintroduce.

## Git infrastructure

All git invocations route through `Sources/TermLoop/Git/GitCommandRunner` — do not spawn `Process()` for git directly.

## Socket command threading policy

- Do not use `DispatchQueue.main.sync` for high-frequency socket telemetry commands.
- For telemetry hot paths, parse and validate off-main.
- Commands that directly manipulate AppKit/Ghostty UI state are allowed to run on main actor.

## Socket focus policy

- Socket/CLI commands must not steal macOS app focus.
- Only explicit focus-intent commands may mutate in-app focus/selection.

## Testing policy

**Never run tests locally.** All tests run via GitHub Actions or on the VM.

## Ghostty vendor workflow

`ghostty/` is a vendored directory inside the parent repo, not a nested git repo.

## Release

Use the `/release` command to prepare a new release.
