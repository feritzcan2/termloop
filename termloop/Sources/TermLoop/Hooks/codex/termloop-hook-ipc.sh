#!/usr/bin/env bash
# termloop-hook-ipc.sh — writes a single v2 NDJSON RPC to the termloop Unix socket.
# Args: $1 = method name (e.g. "workspace.report_agent_activity")
# Stdin: JSON params object
# Exits 0 on any failure (hooks must never block the agent).
set -e
SOCKET="${TERMLOOP_SOCKET_PATH}"
if [ -z "$SOCKET" ] && [ -f "$HOME/Library/Application Support/termloop/last-socket-path" ]; then
    SOCKET=$(cat "$HOME/Library/Application Support/termloop/last-socket-path" 2>/dev/null)
fi
SOCKET="${SOCKET:-$HOME/Library/Application Support/termloop/termloop.sock}"
METHOD="$1"
PARAMS=$(cat)
FRAME=$(printf '{"method":"%s","params":%s,"id":1}\n' "$METHOD" "$PARAMS")

if [ ! -S "$SOCKET" ]; then
    exit 0
fi

printf '%s\n' "$FRAME" | /usr/bin/nc -U -w 2 "$SOCKET" > /dev/null 2>&1 || true
exit 0
