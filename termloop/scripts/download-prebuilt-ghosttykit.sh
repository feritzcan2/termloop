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

derive_ghostty_source_key() {
  local tree_path="${GHOSTTY_PATH:-termloop/ghostty}"
  local index_tree source_key
  local attempt

  if [ ! -d "$REPO_ROOT/ghostty" ]; then
    echo "Missing vendored ghostty checkout. Run ../scripts/sync-upstreams.sh from the parent repo root first." >&2
    return 1
  fi

  for attempt in 1 2 3 4 5; do
    if index_tree="$(git -C "$PARENT_ROOT" write-tree 2>/dev/null)" \
      && source_key="$(git -C "$PARENT_ROOT" rev-parse "${index_tree}:${tree_path}" 2>/dev/null)"; then
      printf '%s\n' "$source_key"
      return 0
    fi
    sleep 0.1
  done

  if git -C "$PARENT_ROOT" diff --cached --quiet -- "$tree_path"; then
    git -C "$PARENT_ROOT" rev-parse "HEAD:${tree_path}" 2>/dev/null
  fi
}

if [ -n "${GHOSTTYKIT_KEY:-}" ]; then
  GHOSTTYKIT_KEY="$GHOSTTYKIT_KEY"
elif [ -n "${GHOSTTY_SHA:-}" ]; then
  # Backward-compatible override used by older callers.
  GHOSTTYKIT_KEY="$GHOSTTY_SHA"
else
  GHOSTTYKIT_KEY="$(derive_ghostty_source_key)"
fi

TAG="xcframework-$GHOSTTYKIT_KEY"
ARCHIVE_NAME="${GHOSTTYKIT_ARCHIVE_NAME:-GhosttyKit.xcframework.tar.gz}"
OUTPUT_DIR="${GHOSTTYKIT_OUTPUT_DIR:-GhosttyKit.xcframework}"
CHECKSUMS_FILE="${GHOSTTYKIT_CHECKSUMS_FILE:-$SCRIPT_DIR/ghosttykit-checksums.txt}"
RELEASE_REPO="${GHOSTTYKIT_RELEASE_REPO:-feritzcan2/termloop}"
DOWNLOAD_URL="${GHOSTTYKIT_URL:-https://github.com/$RELEASE_REPO/releases/download/$TAG/$ARCHIVE_NAME}"
DOWNLOAD_RETRIES="${GHOSTTYKIT_DOWNLOAD_RETRIES:-30}"
DOWNLOAD_RETRY_DELAY="${GHOSTTYKIT_DOWNLOAD_RETRY_DELAY:-20}"

download_archive_with_curl() {
  local retries="$DOWNLOAD_RETRIES"
  local retry_delay="$DOWNLOAD_RETRY_DELAY"

  if [ "${1:-}" = "quick" ]; then
    retries=0
    retry_delay=0
  fi

  curl --fail --show-error --location \
    --retry "$retries" \
    --retry-delay "$retry_delay" \
    --retry-all-errors \
    -o "$ARCHIVE_NAME" \
    "$DOWNLOAD_URL"
}

can_use_gh_release_download() {
  command -v gh >/dev/null 2>&1 || return 1

  if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
    return 0
  fi

  gh auth status --hostname github.com >/dev/null 2>&1
}

download_archive_with_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    return 1
  fi

  rm -f "$ARCHIVE_NAME"
  if [ -n "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
    GH_TOKEN="$GITHUB_TOKEN" gh release download "$TAG" \
      --repo "$RELEASE_REPO" \
      --pattern "$ARCHIVE_NAME" \
      --dir "."
  else
    gh release download "$TAG" \
      --repo "$RELEASE_REPO" \
      --pattern "$ARCHIVE_NAME" \
      --dir "."
  fi
  test -f "$ARCHIVE_NAME"
}

if [ ! -f "$CHECKSUMS_FILE" ]; then
  echo "Missing checksum file: $CHECKSUMS_FILE" >&2
  exit 1
fi

EXPECTED_SHA256="$(
  awk -v key="$GHOSTTYKIT_KEY" '
    $1 == key {
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
  echo "Missing pinned GhosttyKit checksum for key $GHOSTTYKIT_KEY in $CHECKSUMS_FILE" >&2
  exit 1
fi

echo "Downloading $ARCHIVE_NAME for GhosttyKit key $GHOSTTYKIT_KEY"
if can_use_gh_release_download; then
  if ! download_archive_with_gh; then
    echo "Authenticated GitHub release download failed; trying direct URL." >&2
    if ! download_archive_with_curl quick; then
      echo "Failed to download $ARCHIVE_NAME from $RELEASE_REPO release $TAG." >&2
      echo "For private repos, authenticate with 'gh auth login' locally or set GH_TOKEN/GITHUB_TOKEN in CI." >&2
      exit 1
    fi
  fi
else
  if ! download_archive_with_curl; then
    echo "Failed to download $ARCHIVE_NAME from $DOWNLOAD_URL." >&2
    echo "For private repos, install GitHub CLI and authenticate with 'gh auth login'." >&2
    exit 1
  fi
fi

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

if [ -x "$SCRIPT_DIR/validate-ghosttykit.sh" ]; then
  "$SCRIPT_DIR/validate-ghosttykit.sh" \
    --framework "$OUTPUT_DIR" \
    --key "$GHOSTTYKIT_KEY"
fi

echo "Verified and extracted $OUTPUT_DIR"
