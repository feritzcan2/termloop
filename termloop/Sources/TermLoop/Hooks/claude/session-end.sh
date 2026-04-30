#!/usr/bin/env bash
# Claude Code SessionEnd hook -> termloop claude-hook session-end.
# Delegate restore-session cleanup to the CLI.
set -e

PAYLOAD=$(cat)
TERMLOOP_BIN="${TERMLOOP_CLAUDE_HOOK_TERMLOOP_BIN:-${TERMLOOP_BUNDLED_CLI_PATH:-}}"
if [ -z "$TERMLOOP_BIN" ] || [ ! -x "$TERMLOOP_BIN" ]; then
    TERMLOOP_BIN="$(command -v termloop 2>/dev/null || true)"
fi
[ -z "$TERMLOOP_BIN" ] && exit 0

printf '%s' "$PAYLOAD" | "$TERMLOOP_BIN" claude-hook session-end >/dev/null 2>&1 || true
exit 0
