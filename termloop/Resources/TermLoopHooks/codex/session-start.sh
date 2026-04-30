#!/usr/bin/env bash
# Codex SessionStart hook → termloop codex-hook session-start.
# Delegate to the CLI parser so new Codex payload shapes and session-store
# handling stay centralized.
set -e

WORKSPACE_ID="${TERMLOOP_WORKSPACE_ID:-${TERMLOOP_WORKSPACE_ID:-}}"

if [ -n "${TERMLOOP_CODEX_READY_MARKER:-}" ]; then
    rm -f "$TERMLOOP_CODEX_READY_MARKER"
fi

PAYLOAD=$(cat)
TERMLOOP_BIN="${TERMLOOP_BUNDLED_CLI_PATH:-}"
if [ -z "$TERMLOOP_BIN" ] || [ ! -x "$TERMLOOP_BIN" ]; then
    TERMLOOP_BIN="$(command -v termloop 2>/dev/null || true)"
fi
[ -z "$TERMLOOP_BIN" ] && exit 0

if [ -n "$WORKSPACE_ID" ]; then
    printf '%s' "$PAYLOAD" | "$TERMLOOP_BIN" codex-hook session-start --workspace "$WORKSPACE_ID" >/dev/null 2>&1 || true
else
    printf '%s' "$PAYLOAD" | "$TERMLOOP_BIN" codex-hook session-start >/dev/null 2>&1 || true
fi
exit 0
