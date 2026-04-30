#!/usr/bin/env bash
# One-time per-clone setup that wires the TermLoop fork discipline:
#
#   1. Points git at .githooks/ for pre-commit checks.
#   2. Enables the `merge=ours` driver referenced by .gitattributes so the
#      TermLoop-owned paths stay ours during upstream rebases.
#
# Safe to re-run.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

echo "→ core.hooksPath = .githooks"
git config core.hooksPath .githooks

echo "→ merge.ours.driver = true"
git config merge.ours.driver true

chmod +x .githooks/pre-commit scripts/termloop-check.py scripts/generate-hooks-inventory.py 2>/dev/null || true

echo
echo "TermLoop discipline installed. Running the check once to verify:"
echo
python3 scripts/termloop-check.py --vs upstream/main || {
    echo
    echo "(If upstream/main is missing, add the remote first:"
    echo "   git remote add upstream https://github.com/feritzcan2/termloop.git"
    echo "   git fetch upstream)"
}
