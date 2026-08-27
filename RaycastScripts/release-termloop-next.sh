#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Release TermLoop Next
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🚀
# @raycast.packageName TermLoop Next
# @raycast.needsConfirmation true
# @raycast.refreshTime 0

# Documentation:
# @raycast.description Run manual CI for origin/main when needed, then start its release.
# @raycast.author feritzcan

set -euo pipefail

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_SLUG="feritzcan2/termloop"
CI_WORKFLOW="ci.yml"
RELEASE_WORKFLOW="release.yml"

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

for command in git gh python3; do
  need_command "$command"
done

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "TermLoop Next repository not found: $REPO_DIR"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login"
  exit 1
fi

new_run_id() {
  local workflow="$1"
  local event="$2"
  local sha="$3"
  local previous_ids="$4"
  local candidate

  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if ! grep -Fqx "$candidate" <<<"$previous_ids"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(
    gh run list \
      --repo "$REPO_SLUG" \
      --workflow "$workflow" \
      --event "$event" \
      --limit 30 \
      --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$sha\") | .databaseId"
  )
  return 1
}

wait_for_new_run() {
  local workflow="$1"
  local event="$2"
  local sha="$3"
  local previous_ids="$4"
  local run_id=""

  for _attempt in {1..30}; do
    run_id="$(new_run_id "$workflow" "$event" "$sha" "$previous_ids" || true)"
    if [[ -n "$run_id" ]]; then
      printf '%s\n' "$run_id"
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for $workflow to start." >&2
  return 1
}

echo "==> Fetching origin/main and release tags"
git -C "$REPO_DIR" fetch origin --prune --no-tags \
  '+refs/heads/main:refs/remotes/origin/main'
git -C "$REPO_DIR" fetch origin --no-tags \
  '+refs/tags/*:refs/tags/*'

candidate_sha="$(git -C "$REPO_DIR" rev-parse refs/remotes/origin/main)"
version="$(git -C "$REPO_DIR" show "${candidate_sha}:package.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "origin/main has an invalid stable version: $version"
  exit 1
fi
tag="v$version"

echo "Candidate: $candidate_sha"
echo "Version:   $version"
echo "Tag:       $tag"

verified_ci_run_id="$(
  gh run list \
    --repo "$REPO_SLUG" \
    --workflow "$CI_WORKFLOW" \
    --event workflow_dispatch \
    --status success \
    --commit "$candidate_sha" \
    --limit 20 \
    --json databaseId,headSha \
    --jq "[.[] | select(.headSha == \"$candidate_sha\") | .databaseId][0] // empty"
)"
if [[ -z "$verified_ci_run_id" ]]; then
  ci_run_id="$(
    gh run list \
      --repo "$REPO_SLUG" \
      --workflow "$CI_WORKFLOW" \
      --event workflow_dispatch \
      --commit "$candidate_sha" \
      --limit 20 \
      --json databaseId,headSha,status \
      --jq "[.[] | select(.headSha == \"$candidate_sha\" and .status != \"completed\") | .databaseId][0] // empty"
  )"

  if [[ -n "$ci_run_id" ]]; then
    echo "Manual CI is already running: https://github.com/$REPO_SLUG/actions/runs/$ci_run_id"
  else
    ci_previous_ids="$(
      gh run list \
        --repo "$REPO_SLUG" \
        --workflow "$CI_WORKFLOW" \
        --event workflow_dispatch \
        --limit 100 \
        --json databaseId \
        --jq '.[].databaseId'
    )"

    echo
    echo "==> Starting manual CI for exact candidate $candidate_sha"
    gh workflow run "$CI_WORKFLOW" --repo "$REPO_SLUG" --ref main
    ci_run_id="$(wait_for_new_run "$CI_WORKFLOW" workflow_dispatch "$candidate_sha" "$ci_previous_ids")"
    echo "CI started: https://github.com/$REPO_SLUG/actions/runs/$ci_run_id"
  fi

  echo "Waiting for macOS, Linux, and Windows CI to pass..."
  if ! gh run watch "$ci_run_id" \
    --repo "$REPO_SLUG" \
    --compact \
    --exit-status \
    --interval 10; then
    echo "CI did not pass; release was not started: https://github.com/$REPO_SLUG/actions/runs/$ci_run_id" >&2
    exit 1
  fi
  verified_ci_run_id="$ci_run_id"
fi
echo "Verified CI: https://github.com/$REPO_SLUG/actions/runs/$verified_ci_run_id"

remote_tag_sha="$(git -C "$REPO_DIR" ls-remote origin "refs/tags/$tag" | awk 'NR == 1 { print $1 }')"
if [[ "$remote_tag_sha" == "$candidate_sha" ]]; then
  existing_release_run_id="$(
    gh run list \
      --repo "$REPO_SLUG" \
      --workflow "$RELEASE_WORKFLOW" \
      --status success \
      --commit "$candidate_sha" \
      --limit 20 \
      --json databaseId,headSha \
      --jq "[.[] | select(.headSha == \"$candidate_sha\") | .databaseId][0] // empty"
  )"
  if [[ -n "$existing_release_run_id" ]]; then
    existing_release_run_url="https://github.com/$REPO_SLUG/actions/runs/$existing_release_run_id"
    echo "Release already completed for exact candidate: $existing_release_run_url"
    /usr/bin/open "$existing_release_run_url"
    exit 0
  fi

  active_release_run_id="$(
    gh run list \
      --repo "$REPO_SLUG" \
      --workflow "$RELEASE_WORKFLOW" \
      --commit "$candidate_sha" \
      --limit 20 \
      --json databaseId,headSha,status \
      --jq "[.[] | select(.headSha == \"$candidate_sha\" and .status != \"completed\") | .databaseId][0] // empty"
  )"
  if [[ -n "$active_release_run_id" ]]; then
    active_release_run_url="https://github.com/$REPO_SLUG/actions/runs/$active_release_run_id"
    echo "Release is already running for exact candidate: $active_release_run_url"
    /usr/bin/open "$active_release_run_url"
    exit 0
  fi

  release_event="workflow_dispatch"
else
  release_event="push"
fi
release_previous_ids="$(gh run list --repo "$REPO_SLUG" --workflow "$RELEASE_WORKFLOW" --event "$release_event" --limit 100 --json databaseId --jq '.[].databaseId')"

echo
echo "==> Starting GitHub release for exact candidate $candidate_sha"
git -C "$REPO_DIR" tag -f "$tag" "$candidate_sha"
git -C "$REPO_DIR" push --force origin "refs/tags/$tag"

if [[ "$remote_tag_sha" == "$candidate_sha" ]]; then
  echo "Tag already points at the verified candidate; dispatching the release workflow explicitly."
  gh workflow run "$RELEASE_WORKFLOW" --repo "$REPO_SLUG" --ref "$tag" -f "tag=$tag"
fi

release_run_id="$(wait_for_new_run "$RELEASE_WORKFLOW" "$release_event" "$candidate_sha" "$release_previous_ids")"
release_run_url="https://github.com/$REPO_SLUG/actions/runs/$release_run_id"
echo
echo "Release started: $release_run_url"
echo "CI evidence validation, release build, and publish will continue on GitHub."
/usr/bin/open "$release_run_url"
