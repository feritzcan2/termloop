#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook -> termloop claude-hook prompt-submit.
# Delegate turn-start reporting to the CLI.
set -e

WORKSPACE_ID="${TERMLOOP_WORKSPACE_ID:-${TERMLOOP_WORKSPACE_ID:-}}"
[ -z "$WORKSPACE_ID" ] && exit 0

PAYLOAD=$(cat)
TERMLOOP_BIN="${TERMLOOP_CLAUDE_HOOK_TERMLOOP_BIN:-${TERMLOOP_BUNDLED_CLI_PATH:-}}"
if [ -z "$TERMLOOP_BIN" ] || [ ! -x "$TERMLOOP_BIN" ]; then
    TERMLOOP_BIN="$(command -v termloop 2>/dev/null || true)"
fi
[ -z "$TERMLOOP_BIN" ] && exit 0

printf '%s' "$PAYLOAD" | "$TERMLOOP_BIN" claude-hook prompt-submit --workspace "$WORKSPACE_ID" >/dev/null 2>&1 || true
exit 0
