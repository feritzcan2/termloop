#!/usr/bin/env bash
# Codex PermissionRequest hook → termloop workspace.report_agent_activity
# (phase=waiting, attentionKind=permission).
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IPC="${TERMLOOP_HOOK_IPC_OVERRIDE:-$SCRIPT_DIR/termloop-hook-ipc.sh}"

WORKSPACE_ID="${TERMLOOP_WORKSPACE_ID:-${TERMLOOP_WORKSPACE_ID:-}}"
[ -z "$WORKSPACE_ID" ] && exit 0

if [ -n "${TERMLOOP_CODEX_READY_MARKER:-}" ]; then
    rm -f "$TERMLOOP_CODEX_READY_MARKER"
fi

PAYLOAD=$(cat)
PARAMS=$(TERMLOOP_PAYLOAD="$PAYLOAD" TERMLOOP_WORKSPACE_ID="$WORKSPACE_ID" /usr/bin/python3 - <<'PY'
import json, os
try:
    payload = json.loads(os.environ.get("TERMLOOP_PAYLOAD") or "{}")
except Exception:
    payload = {}

preview = ""
for key in ("reason", "description", "summary", "request"):
    v = payload.get(key)
    if isinstance(v, str) and v.strip():
        preview = v[:1000]
        break

out = {
    "workspace_id": os.environ.get("TERMLOOP_WORKSPACE_ID", ""),
    "agent_id": "codex",
    "phase": "waiting",
    "attention_kind": "permission",
    "message_preview": preview or "Approval requested",
}
sid = payload.get("session_id") or payload.get("conversation_id") or ""
if sid:
    out["session_id"] = sid
cwd = payload.get("cwd") or ""
if cwd:
    out["cwd"] = cwd
print(json.dumps(out, separators=(",", ":")))
PY
)

[ -z "$PARAMS" ] && exit 0
printf '%s' "$PARAMS" | "$IPC" workspace.report_agent_activity
exit 0
