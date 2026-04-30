#!/usr/bin/env bash
set -euo pipefail

APP_PATTERN='TermLoop DEV production.app/Contents/MacOS/TermLoop DEV'
PID="${1:-}"
SAMPLE_SECONDS="${2:-5}"

if [[ -z "${PID}" ]]; then
  PID="$(ps -axo pid,pcpu,rss,command | grep "$APP_PATTERN" | grep -v grep | awk 'NR==1{print $1}')"
fi

if [[ -z "${PID}" ]]; then
  echo "cmux production process bulunamadı"
  exit 1
fi

OUT="/tmp/termloop-sample-${PID}.txt"

echo "== Live =="
ps -p "$PID" -o pid,pcpu,rss,etime,command

echo
echo "== Sampling =="
sample "$PID" "$SAMPLE_SECONDS" 1 -file "$OUT" >/dev/null 2>&1 || true
echo "sample file: $OUT"

echo
echo "== Symbol counts =="
python3 - <<'PY' "$OUT"
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(errors='ignore')

keys = [
    "WorktreeAgentsPanel",
    "WorktreeWorkspaceRowView",
    "WorktreeWorkspaceGitChangeBadgeView",
    "ActiveAgentsPanel",
    "ActiveAgentsHeaderView",
    "FolderTreeWorkspaceList",
    "BridgeCoordinator",
    "BridgeMessageExtractor",
    "TerminalAgentRunner",
    "QuickActionAdvancedTable",
    "SkillCatalog",
    "TaggedBuildSharedState",
]

for key in keys:
    count = text.count(key)
    if count:
        print(f"{key}: {count}")
PY

echo
echo "== Top matching lines =="
python3 - <<'PY' "$OUT"
from pathlib import Path
import sys

lines = Path(sys.argv[1]).read_text(errors='ignore').splitlines()
keys = [
    "WorktreeAgentsPanel",
    "WorktreeWorkspaceRowView",
    "WorktreeWorkspaceGitChangeBadgeView",
    "ActiveAgentsPanel",
    "FolderTreeWorkspaceList",
    "BridgeCoordinator",
    "BridgeMessageExtractor",
    "TerminalAgentRunner",
]

count = 0
for line in lines:
    if any(key in line for key in keys):
        print(line[:240])
        count += 1
        if count >= 80:
            break
PY

echo
echo "== Top non-idle termloop leaf frames =="
python3 - <<'PY' "$OUT"
import re
import sys
from collections import defaultdict
from pathlib import Path

text = Path(sys.argv[1]).read_text(errors='ignore').splitlines()

in_graph = False
graph = []
for line in text:
    if line.startswith("Call graph:"):
        in_graph = True
        continue
    if in_graph:
        if line.startswith("Total number") or line.startswith("Binary Images"):
            break
        graph.append(line)

frame_re = re.compile(
    r'^(?P<prefix>[\s+!:|]*)(?P<count>\d+)\s+(?P<sym>.+?)\s+\(in (?P<lib>[^)]+)\)'
)

APP_LIBS = {"TermLoop DEV.debug.dylib"}
SKIP_PREFIXES = (
    "__debug_main_executable_dylib_entry_point",
    "static cmuxApp",
    "thunk for ",
    "google_breakpad::",
)
IDLE_SYSCALLS = {
    "mach_msg", "mach_msg2_trap", "mach_msg_overwrite", "mach_msg2_internal",
    "kevent64", "kevent", "poll", "ppoll", "select", "pselect",
    "accept", "__accept",
    "semaphore_wait_trap", "semaphore_timedwait_trap",
    "__psynch_cvwait", "__psynch_mutexwait", "__psynch_rw_rdlock", "__psynch_rw_wrlock",
    "__ulock_wait", "__ulock_wait2",
    "workq_kernreturn", "_pthread_cond_wait",
    "__wait4", "wait4",
}

parsed = []
for raw in graph:
    m = frame_re.match(raw)
    if not m:
        parsed.append(None)
        continue
    parsed.append({
        'depth': len(m.group('prefix')),
        'count': int(m.group('count')),
        'sym': m.group('sym').strip(),
        'lib': m.group('lib').strip(),
    })

def deepest_leaf_after(i, p):
    """Return the deepest descendant frame of parsed[i] (or None)."""
    deepest = None
    for j in range(i + 1, len(parsed)):
        q = parsed[j]
        if q is None:
            continue
        if q['depth'] <= p['depth']:
            break
        deepest = q
    return deepest

active_credits = defaultdict(int)
idle_credits = defaultdict(int)
for i, p in enumerate(parsed):
    if p is None or p['lib'] not in APP_LIBS:
        continue
    immediate_child = None
    for j in range(i + 1, len(parsed)):
        q = parsed[j]
        if q is None:
            continue
        if q['depth'] <= p['depth']:
            break
        immediate_child = q
        break
    if immediate_child is not None and immediate_child['lib'] in APP_LIBS:
        continue  # not a termloop leaf, deeper termloop frame exists
    sym = p['sym']
    if any(sym.startswith(s) for s in SKIP_PREFIXES):
        continue
    deepest = deepest_leaf_after(i, p)
    is_idle = deepest is not None and deepest['sym'] in IDLE_SYSCALLS
    if is_idle:
        idle_credits[sym] += p['count']
    else:
        active_credits[sym] += p['count']

def print_ranked(label, credits, n=15):
    print(f"-- {label} --")
    if not credits:
        print("  (none)")
        return
    ranked = sorted(credits.items(), key=lambda kv: -kv[1])
    for sym, count in ranked[:n]:
        print(f"  {count:6d}  {sym[:160]}")

print_ranked("Active (CPU / blocking I/O)", active_credits)
print()
print_ranked("Idle waits (kevent/mach_msg/accept/etc.)", idle_credits, n=8)
PY
