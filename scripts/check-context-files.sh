#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-}"
if [[ -z "$ROOT" ]]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

cd "$ROOT"

find_context_files() {
  local follow="$1"
  local find_args=(.)
  if [[ "$follow" == "follow" ]]; then
    find_args=(-L .)
  fi

  find "${find_args[@]}" \
    \( -path './.git' \
      -o -path './node_modules' \
      -o -path './termloop/.build' \
      -o -path './termloop/DerivedData' \
      -o -path './termloop/.termloop-worktrees' \
      -o -path './terminal-app/node_modules' \
      -o -path './terminal-app/.expo' \
      -o -path './terminal-app/dist' \
    \) -prune -o \
    \( -name CLAUDE.md -o -name AGENTS.md -o -name GEMINI.md \) \
    -type l -print
}

broken="$(mktemp)"
symlinks="$(mktemp)"
trap 'rm -f "$broken" "$symlinks"' EXIT

find_context_files follow >"$broken"
find_context_files plain >"$symlinks"

failed=0
if [[ -s "$broken" ]]; then
  echo "Broken context-file symlinks are not allowed:" >&2
  sed 's/^/  /' "$broken" >&2
  failed=1
fi

if [[ -s "$symlinks" ]]; then
  echo "Context files must be real files, not symlinks:" >&2
  sed 's/^/  /' "$symlinks" >&2
  failed=1
fi

exit "$failed"
