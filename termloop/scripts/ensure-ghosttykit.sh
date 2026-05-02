#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PARENT_ROOT="$(cd "$PROJECT_DIR/.." && pwd)"
LOCK_FILE="$PARENT_ROOT/upstreams.lock"

cd "$PROJECT_DIR"

hash_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

hash_file() {
  local path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    sha256sum "$path" | awk '{print $1}'
  fi
}

validate_bridge_header() {
  local path="$1"
  python3 - "$path" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
required = '#include "ghostty/include/ghostty.h"'
if required not in text:
    raise SystemExit(1)
PY
}

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "error: missing upstream lock file at $LOCK_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$LOCK_FILE"

if [[ ! -d "$PROJECT_DIR/ghostty" ]]; then
  echo "error: vendored ghostty source is missing. Run ./scripts/setup.sh first." >&2
  exit 1
fi

if ! command -v zig >/dev/null 2>&1; then
  echo "Error: zig is not installed." >&2
  echo "Install via: brew install zig" >&2
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/ghostty/include/ghostty.h" ]]; then
  echo "error: ghostty/include/ghostty.h is missing. Run ./scripts/setup.sh first." >&2
  exit 1
fi

if ! validate_bridge_header "$PROJECT_DIR/ghostty.h"; then
  echo "error: ghostty.h no longer points at ghostty/include/ghostty.h." >&2
  echo "Restore the bridge header so Xcode uses Ghostty's canonical C API." >&2
  exit 1
fi

GHOSTTY_SHA="$GHOSTTY_COMMIT"
GHOSTTY_KEY="$GHOSTTY_SHA"
GHOSTTY_TREE_PATH="${GHOSTTY_PATH:-termloop/ghostty}"
UNTRACKED_FILES="$(git -C "$PARENT_ROOT" ls-files --others --exclude-standard -- "$GHOSTTY_TREE_PATH")"
if ! git -C "$PARENT_ROOT" diff --quiet -- "$GHOSTTY_TREE_PATH" \
  || ! git -C "$PARENT_ROOT" diff --cached --quiet -- "$GHOSTTY_TREE_PATH" \
  || [[ -n "$UNTRACKED_FILES" ]]; then
  DIRTY_HASH="$(
    {
      printf 'head=%s\n' "$GHOSTTY_SHA"
      git -C "$PARENT_ROOT" diff --cached --binary -- "$GHOSTTY_TREE_PATH"
      git -C "$PARENT_ROOT" diff --binary -- "$GHOSTTY_TREE_PATH"
      if [[ -n "$UNTRACKED_FILES" ]]; then
        printf '\n--untracked--\n'
        while IFS= read -r path; do
          [[ -n "$path" ]] || continue
          printf 'path=%s\n' "$path"
          hash_file "$PARENT_ROOT/$path"
        done <<< "$UNTRACKED_FILES"
      fi
    } | hash_stdin
  )"
  GHOSTTY_KEY="${GHOSTTY_SHA}-dirty-${DIRTY_HASH}"
fi

CACHE_ROOT="${TERMLOOP_GHOSTTYKIT_CACHE_DIR:-$HOME/.cache/termloop/ghosttykit}"
CACHE_DIR="$CACHE_ROOT/$GHOSTTY_KEY"
CACHE_XCFRAMEWORK="$CACHE_DIR/GhosttyKit.xcframework"
LOCAL_XCFRAMEWORK="$PROJECT_DIR/ghostty/macos/GhosttyKit.xcframework"
LOCAL_KEY_STAMP="$LOCAL_XCFRAMEWORK/.ghostty_state_key"
LEGACY_LOCAL_SHA_STAMP="$LOCAL_XCFRAMEWORK/.ghostty_sha"
LOCK_DIR="$CACHE_ROOT/$GHOSTTY_KEY.lock"

mkdir -p "$CACHE_ROOT"

echo "==> Ghostty build key: $GHOSTTY_KEY"

LOCK_TIMEOUT=300
LOCK_START=$SECONDS
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  if (( SECONDS - LOCK_START > LOCK_TIMEOUT )); then
    echo "==> Lock stale (>${LOCK_TIMEOUT}s), removing and retrying..."
    rmdir "$LOCK_DIR" 2>/dev/null || rm -rf "$LOCK_DIR"
    continue
  fi
  echo "==> Waiting for GhosttyKit cache lock for $GHOSTTY_KEY..."
  sleep 1
done
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

if [[ -d "$CACHE_XCFRAMEWORK" ]]; then
  echo "==> Reusing cached GhosttyKit.xcframework"
else
  LOCAL_KEY=""
  if [[ -f "$LOCAL_KEY_STAMP" ]]; then
    LOCAL_KEY="$(cat "$LOCAL_KEY_STAMP")"
  elif [[ -f "$LEGACY_LOCAL_SHA_STAMP" ]]; then
    LOCAL_KEY="$(cat "$LEGACY_LOCAL_SHA_STAMP")"
  fi

  if [[ -d "$LOCAL_XCFRAMEWORK" && "$LOCAL_KEY" == "$GHOSTTY_KEY" ]]; then
    echo "==> Seeding cache from existing local GhosttyKit.xcframework (build key matches)"
  else
    echo "==> Building GhosttyKit.xcframework (this may take a few minutes)..."
    (
      cd ghostty
      zig build -Demit-xcframework=true -Dxcframework-target=universal -Doptimize=ReleaseFast
    )
    echo "$GHOSTTY_KEY" > "$LOCAL_KEY_STAMP"
    echo "$GHOSTTY_SHA" > "$LEGACY_LOCAL_SHA_STAMP"
  fi

  if [[ ! -d "$LOCAL_XCFRAMEWORK" ]]; then
    echo "Error: GhosttyKit.xcframework not found at $LOCAL_XCFRAMEWORK" >&2
    exit 1
  fi

  TMP_DIR="$(mktemp -d "$CACHE_ROOT/.ghosttykit-tmp.XXXXXX")"
  mkdir -p "$CACHE_DIR"
  cp -R "$LOCAL_XCFRAMEWORK" "$TMP_DIR/GhosttyKit.xcframework"
  rm -rf "$CACHE_XCFRAMEWORK"
  mv "$TMP_DIR/GhosttyKit.xcframework" "$CACHE_XCFRAMEWORK"
  rmdir "$TMP_DIR"
  echo "==> Cached GhosttyKit.xcframework at $CACHE_XCFRAMEWORK"
fi

MACOS_ARCHIVE="$CACHE_XCFRAMEWORK/macos-arm64_x86_64/libghostty.a"
if [[ -f "$MACOS_ARCHIVE" ]]; then
  # Xcode 26 can fail to resolve symbols from Ghostty's universal static archive
  # until its ranlib index is refreshed after reuse or copy.
  echo "==> Refreshing libghostty archive index..."
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "error: xcrun is required to refresh libghostty archive index." >&2
    exit 1
  fi
  if ! XCODE_RANLIB="$(xcrun --find ranlib 2>/dev/null)"; then
    echo "error: could not locate ranlib via xcrun." >&2
    exit 1
  fi
  "$XCODE_RANLIB" "$MACOS_ARCHIVE"
fi

echo "==> Creating symlink for GhosttyKit.xcframework..."
ln -sfn "$CACHE_XCFRAMEWORK" GhosttyKit.xcframework
