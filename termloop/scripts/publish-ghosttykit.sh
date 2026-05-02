#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/publish-ghosttykit.sh [options]

Packages, checksum-pins, uploads, and download-tests a GhosttyKit prebuilt for
the current vendored ghostty source tree.

Options:
  --framework PATH       GhosttyKit.xcframework to publish.
                         Defaults to ghostty/macos/GhosttyKit.xcframework.
  --repo OWNER/REPO      GitHub release repo. Defaults to feritzcan2/termloop.
  --no-upload            Package and update checksum metadata, but do not upload.
  --skip-download-test   Do not download the uploaded asset back for validation.
  --clobber              Replace an existing release asset during upload.
  --force-checksum       Replace an existing checksum line when the archive hash
                         changes. Requires --clobber unless --no-upload is used.
  --no-lock-update       Do not update upstreams.lock GHOSTTY_TREE_KEY.
  --dry-run              Validate inputs and print the release target only.
  -h, --help             Show this help.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PARENT_ROOT="$(cd "$PROJECT_DIR/.." && pwd)"
LOCK_FILE="$PARENT_ROOT/upstreams.lock"

FRAMEWORK="$PROJECT_DIR/ghostty/macos/GhosttyKit.xcframework"
RELEASE_REPO="${GHOSTTYKIT_RELEASE_REPO:-feritzcan2/termloop}"
ARCHIVE_NAME="${GHOSTTYKIT_ARCHIVE_NAME:-GhosttyKit.xcframework.tar.gz}"
UPLOAD=1
DOWNLOAD_TEST=1
CLOBBER=0
FORCE_CHECKSUM=0
UPDATE_LOCK=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --framework)
      FRAMEWORK="${2:-}"
      shift 2
      ;;
    --repo)
      RELEASE_REPO="${2:-}"
      shift 2
      ;;
    --no-upload)
      UPLOAD=0
      shift
      ;;
    --skip-download-test)
      DOWNLOAD_TEST=0
      shift
      ;;
    --clobber)
      CLOBBER=1
      shift
      ;;
    --force-checksum)
      FORCE_CHECKSUM=1
      shift
      ;;
    --no-lock-update)
      UPDATE_LOCK=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
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

if [[ -z "$FRAMEWORK" || -z "$RELEASE_REPO" ]]; then
  usage >&2
  exit 1
fi

if [[ "$FORCE_CHECKSUM" -eq 1 && "$UPLOAD" -eq 1 && "$CLOBBER" -ne 1 ]]; then
  echo "error: --force-checksum with upload requires --clobber so the release asset and checksum stay in sync." >&2
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

hash_file() {
  local path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    sha256sum "$path" | awk '{print $1}'
  fi
}

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

update_lock_tree_key() {
  local key="$1"

  if [[ "$UPDATE_LOCK" -ne 1 ]]; then
    return 0
  fi

  if grep -q '^GHOSTTY_TREE_KEY=' "$LOCK_FILE"; then
    perl -0pi -e "s/^GHOSTTY_TREE_KEY=.*\$/GHOSTTY_TREE_KEY=${key}/m" "$LOCK_FILE"
  else
    printf 'GHOSTTY_TREE_KEY=%s\n' "$key" >> "$LOCK_FILE"
  fi
}

existing_checksum_for_key() {
  local key="$1"

  awk -v key="$key" '
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
  ' "$CHECKSUMS_FILE" 2>/dev/null || true
}

write_checksum_for_key() {
  local key="$1"
  local sha="$2"

  if [[ ! -f "$CHECKSUMS_FILE" ]]; then
    touch "$CHECKSUMS_FILE"
  fi

  if grep -q "^${key} " "$CHECKSUMS_FILE"; then
    perl -0pi -e "s/^${key} [0-9a-fA-F]+$/${key} ${sha}/m" "$CHECKSUMS_FILE"
  else
    printf '%s %s\n' "$key" "$sha" >> "$CHECKSUMS_FILE"
  fi
}

require_clean_publish_tree() {
  local untracked

  if ! git -C "$PARENT_ROOT" diff --quiet -- "$GHOSTTY_TREE_PATH"; then
    echo "error: ghostty has unstaged changes. Stage or revert them before publishing a prebuilt." >&2
    git -C "$PARENT_ROOT" status --short -- "$GHOSTTY_TREE_PATH" >&2
    exit 1
  fi

  untracked="$(git -C "$PARENT_ROOT" ls-files --others --exclude-standard -- "$GHOSTTY_TREE_PATH")"
  if [[ -n "$untracked" ]]; then
    echo "error: ghostty has untracked files. Stage or remove them before publishing a prebuilt." >&2
    printf '%s\n' "$untracked" >&2
    exit 1
  fi
}

KEY="$(derive_ghostty_source_key || true)"
if [[ -z "$KEY" ]]; then
  echo "error: could not determine ghostty source tree key" >&2
  exit 1
fi

require_clean_publish_tree

if [[ ! -d "$FRAMEWORK" ]]; then
  echo "error: missing GhosttyKit.xcframework at $FRAMEWORK" >&2
  echo "Run ./scripts/ensure-ghosttykit.sh or build ghostty with -Demit-xcframework=true first." >&2
  exit 1
fi

VALIDATE_ARGS=(
  --framework "$FRAMEWORK"
  --key "$KEY"
  --allow-missing-checksum
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  VALIDATE_ARGS+=(--allow-lock-mismatch)
else
  update_lock_tree_key "$KEY"
fi

"$SCRIPT_DIR/validate-ghosttykit.sh" "${VALIDATE_ARGS[@]}"

TAG="xcframework-$KEY"
OUT_DIR="${TERMLOOP_GHOSTTYKIT_PUBLISH_DIR:-$PROJECT_DIR/.build/ghosttykit-prebuilt/$KEY}"
ARCHIVE="$OUT_DIR/$ARCHIVE_NAME"

echo "GhosttyKit key: $KEY"
echo "Release: $RELEASE_REPO@$TAG"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run complete."
  exit 0
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/termloop-ghosttykit-publish.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$FRAMEWORK" "$TMP_DIR/GhosttyKit.xcframework"
(
  cd "$TMP_DIR"
  COPYFILE_DISABLE=1 tar czf "$ARCHIVE" GhosttyKit.xcframework
)

SHA256="$(hash_file "$ARCHIVE")"
EXISTING_SHA256="$(existing_checksum_for_key "$KEY")"

if [[ -n "$EXISTING_SHA256" && "$EXISTING_SHA256" != "$SHA256" && "$FORCE_CHECKSUM" -ne 1 ]]; then
  echo "error: checksum entry already exists for $KEY but the packaged archive hash differs." >&2
  echo "Existing: $EXISTING_SHA256" >&2
  echo "Packaged: $SHA256" >&2
  echo "Use --clobber --force-checksum only when replacing the release asset intentionally." >&2
  exit 1
fi

write_checksum_for_key "$KEY" "$SHA256"

echo "Archive: $ARCHIVE"
echo "SHA256:  $SHA256"

if [[ "$UPLOAD" -eq 0 ]]; then
  echo "Upload skipped by --no-upload."
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: GitHub CLI is required to publish GhosttyKit prebuilts." >&2
  exit 1
fi

if gh release view "$TAG" --repo "$RELEASE_REPO" >/dev/null 2>&1; then
  UPLOAD_ARGS=(release upload "$TAG" "$ARCHIVE" --repo "$RELEASE_REPO")
  if [[ "$CLOBBER" -eq 1 ]]; then
    UPLOAD_ARGS+=(--clobber)
  fi
  gh "${UPLOAD_ARGS[@]}"
else
  gh release create "$TAG" "$ARCHIVE" \
    --repo "$RELEASE_REPO" \
    --title "$TAG" \
    --notes "GhosttyKit.xcframework for vendored ghostty source tree $KEY"
fi

if [[ "$DOWNLOAD_TEST" -eq 1 ]]; then
  DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/termloop-ghosttykit-download.XXXXXX")"
  (
    cd "$DOWNLOAD_DIR"
    GHOSTTYKIT_RELEASE_REPO="$RELEASE_REPO" \
    GHOSTTYKIT_KEY="$KEY" \
    GHOSTTYKIT_OUTPUT_DIR="$DOWNLOAD_DIR/GhosttyKit.xcframework" \
    "$SCRIPT_DIR/download-prebuilt-ghosttykit.sh"
  )
  "$SCRIPT_DIR/validate-ghosttykit.sh" \
    --framework "$DOWNLOAD_DIR/GhosttyKit.xcframework" \
    --key "$KEY"
  rm -rf "$DOWNLOAD_DIR"
fi

echo "Published GhosttyKit prebuilt for $KEY"
