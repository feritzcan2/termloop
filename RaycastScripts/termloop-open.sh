#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title TermLoop Open
# @raycast.mode compact

# Optional parameters:
# @raycast.argument1 { "type": "text", "placeholder": "instance tag (blank/main = primary)", "optional": true }
# @raycast.argument2 { "type": "text", "placeholder": "checkout: main, branch, worktree, or path (default: main)", "optional": true }
# @raycast.icon 🟣
# @raycast.packageName TermLoop
# @raycast.needsConfirmation false

# Documentation:
# @raycast.description Rebuild main, or launch an isolated tagged build from a selected checkout.
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

if [ ! -d "$TERMLOOP_DIR" ]; then
  echo "TermLoop directory not found: $TERMLOOP_DIR"
  exit 1
fi

tag="${1:-main}"
checkout_selector="${2:-main}"
launcher="$TERMLOOP_DIR/tools/dev/termloop-dev"
checkout=""

if [ ! -x "$launcher" ]; then
  echo "TermLoop launcher not found or not executable: $launcher"
  exit 1
fi

if [ "$checkout_selector" = "main" ]; then
  checkout="$TERMLOOP_DIR"
elif [ -d "$checkout_selector" ]; then
  checkout="$checkout_selector"
elif [ -d "$TERMLOOP_DIR/$checkout_selector" ]; then
  checkout="$TERMLOOP_DIR/$checkout_selector"
elif [ -d "$TERMLOOP_DIR/.termloop-worktrees/$checkout_selector" ]; then
  checkout="$TERMLOOP_DIR/.termloop-worktrees/$checkout_selector"
else
  while IFS= read -r worktree; do
    branch="$(git -C "$worktree" branch --show-current)"
    if [ "$checkout_selector" = "$(basename "$worktree")" ] || [ "$checkout_selector" = "$branch" ]; then
      checkout="$worktree"
      break
    fi
  done < <(git -C "$TERMLOOP_DIR" worktree list --porcelain | sed -n 's/^worktree //p')
fi

if [ -z "$checkout" ]; then
  echo "Unknown checkout: $checkout_selector"
  exit 2
fi

checkout="$(cd "$checkout" && git rev-parse --show-toplevel)"

if [ "$tag" = "main" ]; then
  if [ "$checkout" != "$TERMLOOP_DIR" ]; then
    echo "The main profile can only use the primary checkout. Pass a non-main instance tag for another checkout."
    exit 2
  fi
  exec "$launcher" restart --checkout "$checkout" --main --allow-agent-main
fi
exec "$launcher" restart --checkout "$checkout" --tag "$tag"
