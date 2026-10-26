#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title TermLoop PM Open
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 🟢
# @raycast.packageName TermLoop
# @raycast.needsConfirmation false

# Documentation:
# @raycast.description Rebuild the PM daemon and app from the primary checkout and (re)start TermLoop PM.
# @raycast.author feritzcan

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TERMLOOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

export PATH="/opt/homebrew/opt/zig@0.15/bin:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

if [ -d "$HOME/.nvm/versions/node" ]; then
  for node_bin in "$HOME"/.nvm/versions/node/*/bin; do
    [ -d "$node_bin" ] && export PATH="$node_bin:$PATH"
  done
fi

APP_DIR="$TERMLOOP_DIR/clients/pm"
# A private target directory, so another session's build never stands in
# for this one.
BUILD_TARGET="$TERMLOOP_DIR/target/pm-app"
RUN_DIR="$BUILD_TARGET/run"
DAEMON="$RUN_DIR/termloop-pm-daemon"
LOG="$RUN_DIR/app.log"
CDP_PORT=9333

# A daemon built in a linked worktree opens a dev profile's database, not
# the user's, so only the primary checkout builds the app.
if [ -f "$TERMLOOP_DIR/.git" ]; then
  echo "Run this from the primary checkout, not a worktree."
  exit 2
fi

echo "Building the PM daemon…"
if ! (cd "$TERMLOOP_DIR" && CARGO_TARGET_DIR="$BUILD_TARGET" cargo build -q -p termloop-pm-daemon); then
  echo "The PM daemon did not build."
  exit 1
fi
if strings "$BUILD_TARGET/debug/termloop-pm-daemon" | grep -q profiles-id; then
  echo "The daemon was built for a dev profile; refusing to start it."
  exit 1
fi

echo "Building the PM app…"
if ! (cd "$APP_DIR" && pnpm build >/dev/null); then
  echo "The PM app did not build."
  exit 1
fi

# Stop the PM app this checkout runs: an Electron whose working directory
# is clients/pm. Its daemon exits with it.
stop_running_app() {
  local pid cwd
  for pid in $(pgrep -f "Electron.app/Contents/MacOS/Electron \. " || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    [ "$cwd" = "$APP_DIR" ] || continue
    echo "Stopping the running PM app (pid $pid)…"
    kill -TERM "$pid" 2>/dev/null || continue
    for _ in $(seq 1 40); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
  done
}
stop_running_app

# The app runs a copy, so a later build never replaces the running binary.
mkdir -p "$RUN_DIR"
cp "$BUILD_TARGET/debug/termloop-pm-daemon" "$DAEMON"

cd "$APP_DIR"
TERMLOOP_PM_DAEMON="$DAEMON" nohup pnpm exec electron . --remote-debugging-port="$CDP_PORT" >"$LOG" 2>&1 &

for _ in $(seq 1 60); do
  if pgrep -f "$DAEMON" >/dev/null; then
    echo "TermLoop PM started."
    exit 0
  fi
  sleep 0.5
done
echo "TermLoop PM did not start its daemon; see $LOG"
exit 1
