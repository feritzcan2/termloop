# Contributing to TermLoop

## Prerequisites

- macOS 14+
- Xcode 15+
- [Zig](https://ziglang.org/) (install via `brew install zig`)

## Getting Started

1. Clone the repository and sync vendored upstreams:
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

### Unit Tests

```bash
./scripts/test-unit.sh
```

### Build Check

```bash
xcodebuild -project GhosttyTabs.xcodeproj -scheme termloop -configuration Debug -destination "platform=macOS" build
```

### UI Tests

```bash
xcodebuild -project GhosttyTabs.xcodeproj -scheme termloop -configuration Debug -destination "platform=macOS" -only-testing:termloopUITests test
```

The broader Python smoke suites under `tests/` and `tests_v2/` launch and control the app. Run them from a disposable macOS test environment or VM so they cannot interfere with your daily TermLoop session.

## Ghostty Source

The vendored `ghostty/` directory is synced from the Ghostty source configured in the repository-level `upstreams.lock` via `scripts/sync-upstreams.sh`.

### Making changes to ghostty

```bash
cd ghostty
# make changes
git status
# commit in this repository, then port upstream manually if needed
```

### Keeping the fork updated

```bash
cd ghostty
git fetch origin
git checkout main
git merge origin/main
git push origin main
```

Then update the repository:

```bash
cd ..
git add ghostty
git commit -m "vendor(ghostty): sync fork snapshot"
```

See the repository-level upstream documentation for source provenance and sync notes.

## License

By contributing to this repository, you agree that:

1. Your contributions are licensed under the project's GNU General Public License v3.0 or later (`GPL-3.0-or-later`).
2. You grant Ferit özcan / TermLoop a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, modify, sublicense, and distribute your contributions under any license, including a commercial license offered to third parties.
