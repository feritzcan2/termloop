#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---dry-run}"

if [[ "$MODE" == "--dry-run" ]]; then
  swiftc \
    "$ROOT/Sources/TermLoop/RemoteWorkItems/RemoteWorkItems.swift" \
    "$ROOT/Sources/TermLoop/RemoteWorkItems/RemoteWorkItemCLIProviders.swift" \
    "$ROOT/scripts/remote-work-items/smoke.swift" \
    -o /tmp/remote-work-items-smoke
  /tmp/remote-work-items-smoke
  exit 0
fi

if [[ "$MODE" == "--live-github" ]]; then
  : "${REMOTE_WORK_ITEM_GITHUB_REPO:?Set REMOTE_WORK_ITEM_GITHUB_REPO=owner/repo}"
  swiftc \
    "$ROOT/Sources/TermLoop/RemoteWorkItems/RemoteWorkItems.swift" \
    "$ROOT/Sources/TermLoop/RemoteWorkItems/RemoteWorkItemCLIProviders.swift" \
    "$ROOT/scripts/remote-work-items/smoke.swift" \
    -o /tmp/remote-work-items-smoke
  /tmp/remote-work-items-smoke --live-github
  exit 0
fi

if [[ "$MODE" == "--live-jira" ]]; then
  swiftc \
    "$ROOT/Sources/TermLoop/RemoteWorkItems/RemoteWorkItems.swift" \
    "$ROOT/Sources/TermLoop/RemoteWorkItems/RemoteWorkItemCLIProviders.swift" \
    "$ROOT/scripts/remote-work-items/smoke.swift" \
    -o /tmp/remote-work-items-smoke
  /tmp/remote-work-items-smoke --live-jira
  exit 0
fi

if [[ "$MODE" == "--live-jira-assigned" ]]; then
  swiftc \
    "$ROOT/Sources/TermLoop/RemoteWorkItems/RemoteWorkItems.swift" \
    "$ROOT/Sources/TermLoop/RemoteWorkItems/RemoteWorkItemCLIProviders.swift" \
    "$ROOT/scripts/remote-work-items/smoke.swift" \
    -o /tmp/remote-work-items-smoke
  /tmp/remote-work-items-smoke --live-jira-assigned
  exit 0
fi

cat >&2 <<USAGE
Usage:
  $0 --dry-run
  REMOTE_WORK_ITEM_GITHUB_REPO=owner/repo $0 --live-github
  REMOTE_WORK_ITEM_JIRA_PROJECT=KAN REMOTE_WORK_ITEM_JIRA_DONE_STATUS=Done $0 --live-jira
  REMOTE_WORK_ITEM_JIRA_PROJECT=KAN $0 --live-jira-assigned
USAGE
exit 2
