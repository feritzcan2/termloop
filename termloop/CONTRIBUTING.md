# Contributing to cmux

## Prerequisites

- macOS 14+
- Xcode 15+
- [Zig](https://ziglang.org/) (install via `brew install zig`)

## Getting Started

1. Clone the parent repository and sync vendored upstreams:
   ```bash
   git clone https://github.com/feritzcan2/termloop.git
   cd termloop
   ./scripts/sync-upstreams.sh
   cd termloop
   ```

2. Run the setup script:
   ```bash
   ./scripts/setup.sh
   ```

   This will:
   - Verify vendored upstream directories are present
   - Build the GhosttyKit.xcframework from source
   - Create the necessary symlinks

3. Build the debug app:
   ```bash
   ./scripts/reload.sh --tag my-feature
   ```
   The script prints the `.app` path. Cmd-click to open, or pass `--launch` to open automatically.

## Development Scripts

| Script | Description |
|--------|-------------|
| `./scripts/setup.sh` | One-time setup (verify vendored deps + xcframework) |
| `./scripts/reload.sh` | Build Debug app (pass `--launch` to also open it) |
| `./scripts/reloadp.sh` | Build and launch Release app |
| `./scripts/reload2.sh` | Reload both Debug and Release |
| `./scripts/rebuild.sh` | Clean rebuild |

## Rebuilding GhosttyKit

If you make changes to the vendored `ghostty/` source, rebuild the xcframework:

```bash
cd ghostty
zig build -Demit-xcframework=true -Doptimize=ReleaseFast
```

## Running Tests

### Basic tests (run on VM)

```bash
ssh cmux-vm 'cd /Users/termloop/GhosttyTabs && xcodebuild -project GhosttyTabs.xcodeproj -scheme termloop -configuration Debug -destination "platform=macOS" build && pkill -x "TermLoop DEV" || true && APP=$(find /Users/termloop/Library/Developer/Xcode/DerivedData -path "*/Build/Products/Debug/TermLoop DEV.app" -print -quit) && open "$APP" && for i in {1..20}; do [ -S /tmp/cmux.sock ] && break; sleep 0.5; done && python3 tests/test_update_timing.py && python3 tests/test_signals_auto.py && python3 tests/test_ctrl_socket.py && python3 tests/test_notifications.py'
```

### UI tests (run on VM)

```bash
ssh cmux-vm 'cd /Users/termloop/GhosttyTabs && xcodebuild -project GhosttyTabs.xcodeproj -scheme termloop -configuration Debug -destination "platform=macOS" -only-testing:termloopUITests test'
```

## Ghostty Source

The vendored `ghostty/` directory is synced from [feritzcan2/ghostty](https://github.com/feritzcan2/ghostty) via the parent repo's `scripts/sync-upstreams.sh`.

### Making changes to ghostty

```bash
cd ghostty
# make changes
git status
# commit in the parent repo, then port upstream manually if needed
```

### Keeping the fork updated

```bash
cd ghostty
git fetch origin
git checkout main
git merge origin/main
git push manaflow main
```

Then update the parent repo:

```bash
cd ..
git add ghostty
git commit -m "vendor(ghostty): sync fork snapshot"
```

See `docs/ghostty-fork.md` for details on fork changes and conflict notes.

## License

By contributing to this repository, you agree that:

1. Your contributions are licensed under the project's GNU General Public License v3.0 or later (`GPL-3.0-or-later`).
2. You grant Manaflow, Inc. a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, modify, sublicense, and distribute your contributions under any license, including a commercial license offered to third parties.
