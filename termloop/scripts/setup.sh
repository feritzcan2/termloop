#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

if [ ! -d "$PROJECT_DIR/ghostty" ] || [ ! -d "$PROJECT_DIR/vendor/bonsplit" ]; then
    echo "Error: vendored upstream directories are missing." >&2
    echo "Run ../scripts/sync-upstreams.sh from the parent repo root first." >&2
    exit 1
fi

echo "==> Vendored dependencies present."

"$SCRIPT_DIR/ensure-ghosttykit.sh"

echo "==> Setup complete!"
echo ""
echo "You can now build and run the app:"
echo "  ./scripts/reload.sh --tag first-run"
