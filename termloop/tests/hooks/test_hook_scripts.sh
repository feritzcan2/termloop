#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/Sources/TermLoop/Hooks/claude/stop.sh"
FIXTURE_DIR=$(mktemp -d)
trap "rm -rf $FIXTURE_DIR" EXIT

TRANSCRIPT="$FIXTURE_DIR/t.jsonl"
cat > "$TRANSCRIPT" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}
{"type":"user","message":{"content":"hi"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"LAST MESSAGE"}]}}
EOF

RECORD="$FIXTURE_DIR/sent.txt"
export TERMLOOP_HOOK_IPC_OVERRIDE="$FIXTURE_DIR/record.sh"
cat > "$TERMLOOP_HOOK_IPC_OVERRIDE" <<EOF
#!/usr/bin/env bash
echo "method=\$1" > "$RECORD"
cat >> "$RECORD"
EOF
chmod +x "$TERMLOOP_HOOK_IPC_OVERRIDE"

echo "{\"transcript_path\":\"$TRANSCRIPT\",\"session_id\":\"abc\",\"cwd\":\"/tmp\"}" | "$HOOK"

test "$(head -n1 $RECORD)" = "method=internal.hook_event" || { echo "method wrong"; exit 1; }
grep -q '"session_id":"abc"' "$RECORD"               || { echo "missing session_id"; exit 1; }
grep -q '"kind":"stop"' "$RECORD"                    || { echo "missing kind"; exit 1; }
grep -q '"message_preview":"LAST MESSAGE"' "$RECORD" || { echo "wrong message"; exit 1; }

echo "PASS: stop.sh"

# --- notification.sh ---
HOOK_N="$ROOT/Sources/TermLoop/Hooks/claude/notification.sh"
RECORD2="$FIXTURE_DIR/sent2.txt"
RECORD_SCRIPT2="$FIXTURE_DIR/record2.sh"
cat > "$RECORD_SCRIPT2" <<EOF
#!/usr/bin/env bash
echo "method=\$1" > "$RECORD2"
cat >> "$RECORD2"
EOF
chmod +x "$RECORD_SCRIPT2"
echo '{"session_id":"s1","message":"permission needed"}' \
  | TERMLOOP_HOOK_IPC_OVERRIDE="$RECORD_SCRIPT2" "$HOOK_N"

grep -q '"kind":"notification"' "$RECORD2"                    || { echo "notification kind wrong"; exit 1; }
grep -q '"message_preview":"permission needed"' "$RECORD2"    || { echo "notification preview wrong"; exit 1; }

echo "PASS: notification.sh"
