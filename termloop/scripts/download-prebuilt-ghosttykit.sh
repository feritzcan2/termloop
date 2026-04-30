#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PARENT_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
LOCK_FILE="$PARENT_ROOT/upstreams.lock"

if [ ! -f "$LOCK_FILE" ]; then
  echo "Missing upstream lock file: $LOCK_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$LOCK_FILE"

if [ -n "${GHOSTTY_SHA:-}" ]; then
  GHOSTTY_SHA="$GHOSTTY_SHA"
else
  if [ ! -d "$REPO_ROOT/ghostty" ]; then
    echo "Missing vendored ghostty checkout. Run ../scripts/sync-upstreams.sh from the parent repo root first." >&2
    exit 1
  fi
  GHOSTTY_SHA="$GHOSTTY_COMMIT"
fi

TAG="xcframework-$GHOSTTY_SHA"
ARCHIVE_NAME="${GHOSTTYKIT_ARCHIVE_NAME:-GhosttyKit.xcframework.tar.gz}"
OUTPUT_DIR="${GHOSTTYKIT_OUTPUT_DIR:-GhosttyKit.xcframework}"
CHECKSUMS_FILE="${GHOSTTYKIT_CHECKSUMS_FILE:-$SCRIPT_DIR/ghosttykit-checksums.txt}"
DOWNLOAD_URL="${GHOSTTYKIT_URL:-https://github.com/manaflow-ai/ghostty/releases/download/$TAG/$ARCHIVE_NAME}"
DOWNLOAD_RETRIES="${GHOSTTYKIT_DOWNLOAD_RETRIES:-30}"
DOWNLOAD_RETRY_DELAY="${GHOSTTYKIT_DOWNLOAD_RETRY_DELAY:-20}"

if [ ! -f "$CHECKSUMS_FILE" ]; then
  echo "Missing checksum file: $CHECKSUMS_FILE" >&2
  exit 1
fi

EXPECTED_SHA256="$(
  awk -v sha="$GHOSTTY_SHA" '
    $1 == sha {
      print $2
      found = 1
      exit
    }
    END {
      if (!found) {
        exit 1
      }
    }
  ' "$CHECKSUMS_FILE" || true
)"

if [ -z "$EXPECTED_SHA256" ]; then
  echo "Missing pinned GhosttyKit checksum for ghostty $GHOSTTY_SHA in $CHECKSUMS_FILE" >&2
  exit 1
fi

echo "Downloading $ARCHIVE_NAME for ghostty $GHOSTTY_SHA"
curl --fail --show-error --location \
  --retry "$DOWNLOAD_RETRIES" \
  --retry-delay "$DOWNLOAD_RETRY_DELAY" \
  --retry-all-errors \
  -o "$ARCHIVE_NAME" \
  "$DOWNLOAD_URL"

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE_NAME" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "$ARCHIVE_NAME checksum mismatch" >&2
  echo "Expected: $EXPECTED_SHA256" >&2
  echo "Actual:   $ACTUAL_SHA256" >&2
  exit 1
fi

rm -rf "$OUTPUT_DIR"
tar xzf "$ARCHIVE_NAME"
rm "$ARCHIVE_NAME"
test -d "$OUTPUT_DIR"

echo "Verified and extracted $OUTPUT_DIR"
