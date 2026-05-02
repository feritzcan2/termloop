#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: ./scripts/sync-upstreams.sh [--force] [all|termloop|ghostty|homebrew-termloop|bonsplit]

Syncs vendored upstream directories into the current repo and updates
upstreams.lock with the resolved commit SHA for each synced component.

Refuses to sync over dirty vendored directories unless --force is passed.

Examples:
  ./scripts/sync-upstreams.sh
  ./scripts/sync-upstreams.sh termloop
  ./scripts/sync-upstreams.sh ghostty
  ./scripts/sync-upstreams.sh --force ghostty
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="$REPO_ROOT/upstreams.lock"
TARGET="all"
FORCE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)
            FORCE=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        all|termloop|ghostty|homebrew-termloop|bonsplit)
            TARGET="$1"
            shift
            ;;
        *)
            usage >&2
            exit 1
            ;;
    esac
done

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
    if grep -q "^${key}=" "$LOCK_FILE"; then
        perl -0pi -e "s/^${key}=.*\$/${key}=${value}/m" "$LOCK_FILE"
    else
        printf '%s=%s\n' "$key" "$value" >> "$LOCK_FILE"
    fi
}

path_has_changes() {
    local path="$1"
    shift
    local -a pathspecs=("$path")
    local exclude=""

    for exclude in "$@"; do
        pathspecs+=(":(exclude)$exclude")
    done

    if ! git -C "$REPO_ROOT" diff --quiet -- "${pathspecs[@]}"; then
        return 0
    fi
    if ! git -C "$REPO_ROOT" diff --cached --quiet -- "${pathspecs[@]}"; then
        return 0
    fi
    if [[ -n "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard -- "${pathspecs[@]}")" ]]; then
        return 0
    fi

    return 1
}

require_clean_path() {
    local label="$1"
    local path="$2"
    shift 2

    if [[ "$FORCE" -eq 1 ]]; then
        return 0
    fi
    if path_has_changes "$path" "$@"; then
        echo "error: refusing to sync dirty vendored path: $path ($label)" >&2
        echo "Commit/stash the local vendor changes first, or rerun with --force to overwrite them." >&2
        exit 1
    fi
}

tree_key_for_worktree_path() {
    local path="$1"
    local tmp_index="$TMP_DIR/tree-index"
    local root_tree

    rm -f "$tmp_index"
    (
        cd "$REPO_ROOT"
        GIT_INDEX_FILE="$tmp_index" git add -A -- "$path"
        root_tree="$(GIT_INDEX_FILE="$tmp_index" git write-tree)"
        git rev-parse "${root_tree}:${path}"
    )
}

preflight_sync() {
    case "$TARGET" in
        all)
            require_clean_path "termloop" "$TERMLOOP_PATH" \
                "$GHOSTTY_PATH" \
                "$HOMEBREW_TERMLOOP_PATH" \
                "$BONSPLIT_PATH"
            require_clean_path "ghostty" "$GHOSTTY_PATH"
            require_clean_path "homebrew-termloop" "$HOMEBREW_TERMLOOP_PATH"
            require_clean_path "bonsplit" "$BONSPLIT_PATH"
            ;;
        termloop)
            require_clean_path "termloop" "$TERMLOOP_PATH" \
                "$GHOSTTY_PATH" \
                "$HOMEBREW_TERMLOOP_PATH" \
                "$BONSPLIT_PATH"
            ;;
        ghostty)
            require_clean_path "ghostty" "$GHOSTTY_PATH"
            ;;
        homebrew-termloop)
            require_clean_path "homebrew-termloop" "$HOMEBREW_TERMLOOP_PATH"
            ;;
        bonsplit)
            require_clean_path "bonsplit" "$BONSPLIT_PATH"
            ;;
    esac
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
    update_lock_value "GHOSTTY_TREE_KEY" "$(tree_key_for_worktree_path "$GHOSTTY_PATH")"
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

preflight_sync

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
