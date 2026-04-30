#!/usr/bin/env bash
# Claude Code SessionStart hook.
#
# Two responsibilities:
#   1. Block sessions whose actual cwd/branch drift from the worktree
#      binding termloop intended at spawn time (when TERMLOOP_WORKTREE_PATH
#      is set).
#   2. Delegate lifecycle reporting to `cmux claude-hook session-start` so
#      session-store mapping, reverse lookup, and resume persistence all
#      stay on the CLI's normalization path.
set -euo pipefail

PAYLOAD=$(cat || true)

expected_path="${TERMLOOP_WORKTREE_PATH:-}"
expected_branch="${TERMLOOP_WORKTREE_BRANCH:-}"

normalize_path() {
  TARGET_PATH="$1" /usr/bin/python3 - <<'PY'
import os
target = os.environ.get("TARGET_PATH", "")
print(os.path.realpath(target) if target else "")
PY
}

if [ -n "$expected_path" ]; then
  actual_pwd="$(pwd -P)"
  normalized_expected="$(normalize_path "$expected_path")"
  actual_branch="$(git branch --show-current 2>/dev/null || true)"
  if [ "$actual_pwd" != "$normalized_expected" ] || { [ -n "$expected_branch" ] && [ "$actual_branch" != "$expected_branch" ]; }; then
    echo "ERROR: shell cwd=$actual_pwd branch=$actual_branch but expected $normalized_expected on $expected_branch" >&2
    exit 1
  fi
fi

# Ready/report signal — best-effort, never blocks claude on failure.
WORKSPACE_ID="${TERMLOOP_WORKSPACE_ID:-${TERMLOOP_WORKSPACE_ID:-}}"
if [ -n "$WORKSPACE_ID" ]; then
  TERMLOOP_BIN="${TERMLOOP_CLAUDE_HOOK_TERMLOOP_BIN:-${TERMLOOP_BUNDLED_CLI_PATH:-}}"
  if [ -z "$TERMLOOP_BIN" ] || [ ! -x "$TERMLOOP_BIN" ]; then
    TERMLOOP_BIN="$(command -v termloop 2>/dev/null || true)"
  fi
  if [ -n "$TERMLOOP_BIN" ]; then
    printf '%s' "$PAYLOAD" | "$TERMLOOP_BIN" claude-hook session-start --workspace "$WORKSPACE_ID" >/dev/null 2>&1 || true
  fi
fi

exit 0
