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

# Development never auto-reconciles the shared production gateway from daemon
# startup. This explicit launcher action asks the mobile-owned installer to
# compare its embedded build stamp and atomically refresh an existing dev-owned
# install. The launcher explicitly permits another development checkout to take
# ownership, but never takes over a production-channel install. It never reads
# runtime.json, contacts Tailscale, reruns Serve, or regenerates stable tokens.
refresh_mobile_gateway() {
  local access_root="$HOME/Library/Application Support/TermLoop Mobile Access"
  [ -e "$checkout/clients/mobile/scripts/mobile-access.mjs" ] || return 0
  ls "$access_root"/mac-*/mobile-access-gateway.mjs >/dev/null 2>&1 || return 0
  if (cd "$checkout/clients/mobile" && node scripts/mobile-access.mjs --reconcile --take-development-ownership --skip-gateway-wait >/dev/null 2>&1); then
    echo "Mobile access gateway checked."
  else
    echo "Mobile access gateway reconcile failed; launching anyway (run 'pnpm mobile-access -- --reconcile' in clients/mobile to retry)."
  fi
  return 0
}
refresh_mobile_gateway

if [ "$tag" = "main" ]; then
  if [ "$checkout" != "$TERMLOOP_DIR" ]; then
    echo "The main profile can only use the primary checkout. Pass a non-main instance tag for another checkout."
    exit 2
  fi
  exec "$launcher" restart --checkout "$checkout" --main --allow-agent-main
fi
exec "$launcher" restart --checkout "$checkout" --tag "$tag"
