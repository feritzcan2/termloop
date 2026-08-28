#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Promote TermLoop to Main
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon ⬆️
# @raycast.packageName TermLoop
# @raycast.needsConfirmation true
# @raycast.refreshTime 0

# Documentation:
# @raycast.description Verify origin/develop on every native host, then fast-forward main to that exact commit.
# @raycast.author feritzcan

set -euo pipefail

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_SLUG="feritzcan2/termloop"
SOURCE_BRANCH="develop"
TARGET_BRANCH="main"
CI_WORKFLOW="ci.yml"
LOCK_DIR="${TMPDIR:-/tmp}/termloop-promote-main-${UID}"

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

for command in git gh jq; do
  need_command "$command"
done

if [[ ! -d "$REPO_DIR/.git" && ! -f "$REPO_DIR/.git" ]]; then
  echo "TermLoop repository not found: $REPO_DIR"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login"
  exit 1
fi

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  existing_pid="$(sed -n '1p' "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "Another TermLoop main promotion is already active."
    exit 1
  fi

  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || {
    echo "Cannot recover stale promotion lock: $LOCK_DIR"
    exit 1
  }
  mkdir "$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

acquire_lock
cleanup() {
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

worktree_for_branch() {
  local branch="$1"
  git -C "$REPO_DIR" worktree list --porcelain | awk -v wanted="refs/heads/$branch" '
    /^worktree / { path = substr($0, 10) }
    /^branch / && substr($0, 8) == wanted { print path; exit }
  '
}

ci_runs_for_candidate() {
  local candidate_sha="$1"
  gh run list \
    --repo "$REPO_SLUG" \
    --workflow "$CI_WORKFLOW" \
    --commit "$candidate_sha" \
    --limit 50 \
    --json databaseId,headSha,event,status,conclusion,createdAt,url \
    --jq "[.[] | select(.headSha == \"$candidate_sha\" and (.event == \"push\" or .event == \"workflow_dispatch\"))]"
}

echo "==> Fetching protected branches"
git -C "$REPO_DIR" fetch origin --prune --no-tags \
  "+refs/heads/$SOURCE_BRANCH:refs/remotes/origin/$SOURCE_BRANCH" \
  "+refs/heads/$TARGET_BRANCH:refs/remotes/origin/$TARGET_BRANCH"

candidate_sha="$(git -C "$REPO_DIR" rev-parse "refs/remotes/origin/$SOURCE_BRANCH")"
target_sha="$(git -C "$REPO_DIR" rev-parse "refs/remotes/origin/$TARGET_BRANCH")"

echo "Candidate: origin/$SOURCE_BRANCH $candidate_sha"
echo "Target:    origin/$TARGET_BRANCH $target_sha"

source_checkout="$(worktree_for_branch "$SOURCE_BRANCH")"
if [[ -n "$source_checkout" ]]; then
  if [[ -n "$(git -C "$source_checkout" status --porcelain)" ]]; then
    echo "$SOURCE_BRANCH checkout has uncommitted work: $source_checkout"
    exit 1
  fi
  local_source_sha="$(git -C "$source_checkout" rev-parse HEAD)"
  if [[ "$local_source_sha" != "$candidate_sha" ]]; then
    echo "Local $SOURCE_BRANCH is not pushed exactly to origin/$SOURCE_BRANCH."
    echo "Local:  $local_source_sha"
    echo "Remote: $candidate_sha"
    exit 1
  fi
fi

if git -C "$REPO_DIR" merge-base --is-ancestor "$candidate_sha" "$target_sha"; then
  if [[ "$candidate_sha" == "$target_sha" ]]; then
    echo "origin/$TARGET_BRANCH already points at the exact candidate. Nothing to promote."
  else
    echo "The candidate is already contained in newer origin/$TARGET_BRANCH. Nothing to promote."
  fi
  exit 0
fi

if ! git -C "$REPO_DIR" merge-base --is-ancestor "$target_sha" "$candidate_sha"; then
  echo "origin/$SOURCE_BRANCH has diverged from origin/$TARGET_BRANCH."
  echo "Integrate origin/$TARGET_BRANCH into $SOURCE_BRANCH, push it, and run promotion again."
  exit 1
fi

runs_json="$(ci_runs_for_candidate "$candidate_sha")"
successful_run_id="$(jq -r '[.[] | select(.status == "completed" and .conclusion == "success")][0].databaseId // empty' <<<"$runs_json")"
active_run_id="$(jq -r '[.[] | select(.status != "completed")][0].databaseId // empty' <<<"$runs_json")"
failed_run_url="$(jq -r '[.[] | select(.status == "completed" and .conclusion != "success")][0].url // empty' <<<"$runs_json")"

if [[ -n "$successful_run_id" ]]; then
  echo "Verified native CI: https://github.com/$REPO_SLUG/actions/runs/$successful_run_id"
elif [[ -n "$active_run_id" ]]; then
  echo "Native CI is already running: https://github.com/$REPO_SLUG/actions/runs/$active_run_id"
  if ! gh run watch "$active_run_id" \
    --repo "$REPO_SLUG" \
    --compact \
    --exit-status \
    --interval 10; then
    echo "Native CI did not pass. Main was not changed." >&2
    exit 1
  fi
  successful_run_id="$active_run_id"
elif [[ -n "$failed_run_url" ]]; then
  echo "The exact candidate already has a failed native CI run: $failed_run_url" >&2
  echo "Fix the failure with a new commit, or explicitly rerun a proven transient failure." >&2
  exit 1
else
  previous_ids="$(gh run list --repo "$REPO_SLUG" --workflow "$CI_WORKFLOW" --event workflow_dispatch --limit 100 --json databaseId --jq '.[].databaseId')"
  echo "==> Starting native CI for the exact candidate"
  gh workflow run "$CI_WORKFLOW" --repo "$REPO_SLUG" --ref "$SOURCE_BRANCH"

  active_run_id=""
  for _attempt in {1..30}; do
    while IFS= read -r run_id; do
      [[ -n "$run_id" ]] || continue
      if ! grep -Fqx "$run_id" <<<"$previous_ids"; then
        active_run_id="$run_id"
        break
      fi
    done < <(
      gh run list \
        --repo "$REPO_SLUG" \
        --workflow "$CI_WORKFLOW" \
        --event workflow_dispatch \
        --commit "$candidate_sha" \
        --limit 30 \
        --json databaseId,headSha \
        --jq ".[] | select(.headSha == \"$candidate_sha\") | .databaseId"
    )
    [[ -z "$active_run_id" ]] || break
    sleep 2
  done

  if [[ -z "$active_run_id" ]]; then
    echo "Timed out waiting for native CI to start. Main was not changed." >&2
    exit 1
  fi

  echo "Native CI started: https://github.com/$REPO_SLUG/actions/runs/$active_run_id"
  if ! gh run watch "$active_run_id" \
    --repo "$REPO_SLUG" \
    --compact \
    --exit-status \
    --interval 10; then
    echo "Native CI did not pass. Main was not changed." >&2
    exit 1
  fi
  successful_run_id="$active_run_id"
fi

main_checkout="$(worktree_for_branch "$TARGET_BRANCH")"
if [[ -z "$main_checkout" ]]; then
  echo "No designated local $TARGET_BRANCH checkout exists."
  echo "Create one with git worktree before promoting."
  exit 1
fi

if [[ -n "$(git -C "$main_checkout" status --porcelain)" ]]; then
  echo "$TARGET_BRANCH checkout has uncommitted work: $main_checkout"
  exit 1
fi

echo "==> Fast-forwarding local $TARGET_BRANCH to the verified candidate"
git -C "$main_checkout" fetch origin --prune --no-tags \
  "+refs/heads/$TARGET_BRANCH:refs/remotes/origin/$TARGET_BRANCH"

local_main_sha="$(git -C "$main_checkout" rev-parse HEAD)"
remote_main_sha="$(git -C "$main_checkout" rev-parse "refs/remotes/origin/$TARGET_BRANCH")"
if [[ "$local_main_sha" != "$remote_main_sha" ]]; then
  if git -C "$main_checkout" merge-base --is-ancestor "$local_main_sha" "$remote_main_sha"; then
    git -C "$main_checkout" merge --ff-only "refs/remotes/origin/$TARGET_BRANCH"
  else
    echo "Local $TARGET_BRANCH contains work that is not on origin/$TARGET_BRANCH. Refusing to overwrite it."
    exit 1
  fi
fi

if git -C "$main_checkout" merge-base --is-ancestor "$candidate_sha" "refs/remotes/origin/$TARGET_BRANCH"; then
  echo "The verified candidate is already present on origin/$TARGET_BRANCH."
else
  if ! git -C "$main_checkout" merge-base --is-ancestor "refs/remotes/origin/$TARGET_BRANCH" "$candidate_sha"; then
    echo "origin/$TARGET_BRANCH changed and now diverges from the verified candidate."
    exit 1
  fi
  git -C "$main_checkout" merge --ff-only "$candidate_sha"
  git -C "$main_checkout" push origin "refs/heads/$TARGET_BRANCH"
fi

git -C "$main_checkout" fetch origin --prune --no-tags \
  "+refs/heads/$TARGET_BRANCH:refs/remotes/origin/$TARGET_BRANCH"
final_local_sha="$(git -C "$main_checkout" rev-parse HEAD)"
final_remote_sha="$(git -C "$main_checkout" rev-parse "refs/remotes/origin/$TARGET_BRANCH")"
if [[ "$final_local_sha" != "$final_remote_sha" ]]; then
  echo "Local and remote $TARGET_BRANCH differ after promotion." >&2
  exit 1
fi
if ! git -C "$main_checkout" merge-base --is-ancestor "$candidate_sha" "$final_remote_sha"; then
  echo "The verified candidate is not present in final $TARGET_BRANCH." >&2
  exit 1
fi
if [[ -n "$(git -C "$main_checkout" status --porcelain)" ]]; then
  echo "Local $TARGET_BRANCH is unexpectedly dirty after promotion." >&2
  exit 1
fi

echo
echo "Promoted exact verified candidate to $TARGET_BRANCH: $candidate_sha"
echo "Native CI: https://github.com/$REPO_SLUG/actions/runs/$successful_run_id"
