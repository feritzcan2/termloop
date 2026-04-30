#!/usr/bin/env bash
# Claude Code Notification hook → termloop claude-hook notification.
# Delegate session-id extraction and preview shaping to the CLI.
set -e

PAYLOAD=$(cat)
TERMLOOP_BIN="${TERMLOOP_CLAUDE_HOOK_TERMLOOP_BIN:-${TERMLOOP_BUNDLED_CLI_PATH:-}}"
if [ -z "$TERMLOOP_BIN" ] || [ ! -x "$TERMLOOP_BIN" ]; then
    TERMLOOP_BIN="$(command -v termloop 2>/dev/null || true)"
fi
[ -z "$TERMLOOP_BIN" ] && exit 0

printf '%s' "$PAYLOAD" | "$TERMLOOP_BIN" claude-hook notification >/dev/null 2>&1 || true
exit 0
