#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/validate-ghosttykit.sh [--framework PATH] [--key KEY] [--allow-missing-checksum]

Validates that a GhosttyKit.xcframework matches the vendored ghostty source
tree and the pinned prebuilt checksum metadata.

Options:
  --framework PATH          GhosttyKit.xcframework path to validate.
                            Defaults to ./GhosttyKit.xcframework.
  --key KEY                 Expected ghostty source tree key. Defaults to the
                            current vendored termloop/ghostty index tree.
  --allow-missing-checksum  Do not fail when scripts/ghosttykit-checksums.txt
                            has no entry for KEY. Dirty local builds imply this.
  --allow-lock-mismatch     Do not fail when upstreams.lock GHOSTTY_TREE_KEY
                            differs from KEY.
  -h, --help                Show this help.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PARENT_ROOT="$(cd "$PROJECT_DIR/.." && pwd)"
LOCK_FILE="$PARENT_ROOT/upstreams.lock"

FRAMEWORK="$PROJECT_DIR/GhosttyKit.xcframework"
EXPECTED_KEY=""
ALLOW_MISSING_CHECKSUM=0
ALLOW_LOCK_MISMATCH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --framework)
      FRAMEWORK="${2:-}"
      shift 2
      ;;
    --key)
      EXPECTED_KEY="${2:-}"
      shift 2
      ;;
    --allow-missing-checksum|--skip-checksum)
      ALLOW_MISSING_CHECKSUM=1
      shift
      ;;
    --allow-lock-mismatch)
      ALLOW_LOCK_MISMATCH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$FRAMEWORK" ]]; then
  echo "error: --framework requires a path" >&2
  exit 1
fi

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "error: missing upstream lock file at $LOCK_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$LOCK_FILE"

GHOSTTY_TREE_PATH="${GHOSTTY_PATH:-termloop/ghostty}"
CHECKSUMS_FILE="$SCRIPT_DIR/ghosttykit-checksums.txt"

derive_ghostty_source_key() {
  local index_tree source_key
  local attempt

  for attempt in 1 2 3 4 5; do
    if index_tree="$(git -C "$PARENT_ROOT" write-tree 2>/dev/null)" \
      && source_key="$(git -C "$PARENT_ROOT" rev-parse "${index_tree}:${GHOSTTY_TREE_PATH}" 2>/dev/null)"; then
      printf '%s\n' "$source_key"
      return 0
    fi
    sleep 0.1
  done

  if git -C "$PARENT_ROOT" diff --cached --quiet -- "$GHOSTTY_TREE_PATH"; then
    git -C "$PARENT_ROOT" rev-parse "HEAD:${GHOSTTY_TREE_PATH}" 2>/dev/null
  fi
}

CURRENT_KEY="$(derive_ghostty_source_key || true)"
if [[ -z "$EXPECTED_KEY" ]]; then
  EXPECTED_KEY="$CURRENT_KEY"
fi

if [[ -z "$EXPECTED_KEY" ]]; then
  echo "error: could not determine ghostty source tree key" >&2
  exit 1
fi

if [[ ! -d "$FRAMEWORK" ]]; then
  echo "error: missing GhosttyKit.xcframework at $FRAMEWORK" >&2
  exit 1
fi

if [[ ! -f "$FRAMEWORK/Info.plist" ]]; then
  echo "error: missing $FRAMEWORK/Info.plist" >&2
  exit 1
fi

if [[ "$EXPECTED_KEY" != *"-dirty-"* ]]; then
  if [[ -n "$CURRENT_KEY" && "$EXPECTED_KEY" != "$CURRENT_KEY" ]]; then
    echo "error: GhosttyKit key does not match the current vendored ghostty source tree." >&2
    echo "Expected framework key: $EXPECTED_KEY" >&2
    echo "Current source key:    $CURRENT_KEY" >&2
    exit 1
  fi

  if [[ "$ALLOW_LOCK_MISMATCH" -eq 0 && -n "${GHOSTTY_TREE_KEY:-}" && "$EXPECTED_KEY" != "$GHOSTTY_TREE_KEY" ]]; then
    echo "error: upstreams.lock GHOSTTY_TREE_KEY does not match the vendored ghostty source tree." >&2
    echo "upstreams.lock: $GHOSTTY_TREE_KEY" >&2
    echo "current key:    $EXPECTED_KEY" >&2
    exit 1
  fi

  if [[ "$ALLOW_MISSING_CHECKSUM" -eq 0 ]]; then
    if [[ ! -f "$CHECKSUMS_FILE" ]]; then
      echo "error: missing checksum file at $CHECKSUMS_FILE" >&2
      exit 1
    fi
    if ! awk -v key="$EXPECTED_KEY" '$1 == key { found = 1 } END { exit found ? 0 : 1 }' "$CHECKSUMS_FILE"; then
      echo "error: missing pinned GhosttyKit checksum for key $EXPECTED_KEY in $CHECKSUMS_FILE" >&2
      exit 1
    fi
  fi
fi

SOURCE_HEADER="$PROJECT_DIR/ghostty/include/ghostty.h"
FRAMEWORK_HEADER="$FRAMEWORK/macos-arm64_x86_64/Headers/ghostty.h"
FRAMEWORK_ARCHIVE="$FRAMEWORK/macos-arm64_x86_64/libghostty.a"

if [[ ! -f "$SOURCE_HEADER" ]]; then
  echo "error: missing vendored ghostty header at $SOURCE_HEADER" >&2
  exit 1
fi

if [[ ! -f "$FRAMEWORK_HEADER" ]]; then
  echo "error: missing framework header at $FRAMEWORK_HEADER" >&2
  exit 1
fi

if [[ ! -f "$FRAMEWORK_ARCHIVE" ]]; then
  echo "error: missing framework archive at $FRAMEWORK_ARCHIVE" >&2
  exit 1
fi

if grep -q "ghostty_surface_read_text_vt" "$SOURCE_HEADER"; then
  if ! grep -q "ghostty_surface_read_text_vt" "$FRAMEWORK_HEADER"; then
    echo "error: missing ghostty_surface_read_text_vt in $FRAMEWORK_HEADER" >&2
    exit 1
  fi

  if command -v nm >/dev/null 2>&1; then
    SYMBOLS_FILE="$(mktemp)"
    trap 'rm -f "$SYMBOLS_FILE"' EXIT
    if nm -gU "$FRAMEWORK_ARCHIVE" > "$SYMBOLS_FILE" 2>/dev/null; then
      if ! grep -q "_ghostty_surface_read_text_vt" "$SYMBOLS_FILE"; then
        echo "error: missing _ghostty_surface_read_text_vt in $FRAMEWORK_ARCHIVE" >&2
        exit 1
      fi
    fi
  fi
fi

echo "GhosttyKit validation passed for key $EXPECTED_KEY"
