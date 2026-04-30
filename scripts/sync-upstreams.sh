#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: ./scripts/sync-upstreams.sh [all|termloop|ghostty|homebrew-termloop|bonsplit]

Syncs vendored upstream directories into the current repo and updates
upstreams.lock with the resolved commit SHA for each synced component.

Examples:
  ./scripts/sync-upstreams.sh
  ./scripts/sync-upstreams.sh termloop
  ./scripts/sync-upstreams.sh ghostty
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="$REPO_ROOT/upstreams.lock"
TARGET="${1:-all}"

if [[ "$TARGET" == "-h" || "$TARGET" == "--help" ]]; then
    usage
    exit 0
fi

if [[ ! -f "$LOCK_FILE" ]]; then
    echo "Missing lock file: $LOCK_FILE" >&2
    exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
    echo "rsync is required but not installed." >&2
    exit 1
fi

# shellcheck disable=SC1090
source "$LOCK_FILE"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/termloop-upstreams.XXXXXX")"
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

update_lock_value() {
    local key="$1"
    local value="$2"
    perl -0pi -e "s/^${key}=.*\$/${key}=${value}/m" "$LOCK_FILE"
}

sync_repo() {
    local name="$1"
    local repo="$2"
    local branch="$3"
    local path="$4"
    local lock_key="$5"
    shift 5

    local checkout_dir="$TMP_DIR/$name"
    echo "==> Syncing $name from $repo ($branch)"
    git clone --depth 1 --branch "$branch" "$repo" "$checkout_dir" >/dev/null

    local resolved_commit
    resolved_commit="$(git -C "$checkout_dir" rev-parse HEAD)"

    mkdir -p "$REPO_ROOT/$path"
    rsync -a --delete \
        --exclude '.git' \
        --exclude '.gitmodules' \
        "$@" \
        "$checkout_dir/" "$REPO_ROOT/$path/"

    update_lock_value "$lock_key" "$resolved_commit"
    echo "    -> $path @ $resolved_commit"
}

sync_termloop() {
    sync_repo \
        "termloop" \
        "$TERMLOOP_UPSTREAM_REPO" \
        "$TERMLOOP_UPSTREAM_BRANCH" \
        "$TERMLOOP_PATH" \
        "TERMLOOP_UPSTREAM_COMMIT" \
        --exclude 'ghostty' \
        --exclude 'homebrew-cmux' \
        --exclude 'vendor/bonsplit'
}

sync_ghostty() {
    sync_repo \
        "ghostty" \
        "$GHOSTTY_REPO" \
        "$GHOSTTY_BRANCH" \
        "$GHOSTTY_PATH" \
        "GHOSTTY_COMMIT"
}

sync_homebrew_termloop() {
    sync_repo \
        "homebrew-termloop" \
        "$HOMEBREW_TERMLOOP_UPSTREAM_REPO" \
        "$HOMEBREW_TERMLOOP_UPSTREAM_BRANCH" \
        "$HOMEBREW_TERMLOOP_PATH" \
        "HOMEBREW_TERMLOOP_COMMIT"
}

sync_bonsplit() {
    sync_repo \
        "bonsplit" \
        "$BONSPLIT_REPO" \
        "$BONSPLIT_BRANCH" \
        "$BONSPLIT_PATH" \
        "BONSPLIT_COMMIT"
}

case "$TARGET" in
    all)
        sync_termloop
        sync_ghostty
        sync_homebrew_termloop
        sync_bonsplit
        ;;
    termloop)
        sync_termloop
        ;;
    ghostty)
        sync_ghostty
        ;;
    homebrew-termloop)
        sync_homebrew_termloop
        ;;
    bonsplit)
        sync_bonsplit
        ;;
    *)
        usage >&2
        exit 1
        ;;
esac

echo
echo "Sync complete. Review the diff, then run the relevant build/tests."
