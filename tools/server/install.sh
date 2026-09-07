#!/usr/bin/env bash
set -euo pipefail
command -v node >/dev/null || { echo 'Install Node.js 22 or newer before installing TermLoop server.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo 'TermLoop server management requires Node.js 22 or newer.' >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec node "$script_dir/termloop-server-manager.mjs" "$@"
