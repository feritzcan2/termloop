#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Release TermLoop
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🚀
# @raycast.packageName TermLoop
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

open_run_url() {
  local url="$1"
  if [[ "${TERMLOOP_NO_OPEN:-0}" != "1" ]]; then
    /usr/bin/open "$url"
  fi
}

for command in git gh python3; do
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
  'refs/tags/*:refs/tags/*'

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

remote_tag_sha="$(git -C "$REPO_DIR" ls-remote origin "refs/tags/$tag" | awk 'NR == 1 { print $1 }')"
local_tag_sha="$(git -C "$REPO_DIR" rev-parse --verify -q "refs/tags/$tag" || true)"

if [[ -n "$remote_tag_sha" && "$remote_tag_sha" != "$candidate_sha" ]]; then
  echo "Release tag already exists at a different immutable object: $tag -> $remote_tag_sha" >&2
  echo "Bump the project version; published tags are never moved." >&2
  exit 1
fi
if [[ -n "$local_tag_sha" && "$local_tag_sha" != "$candidate_sha" ]]; then
  echo "Local release tag points somewhere else: $tag -> $local_tag_sha" >&2
  echo "Resolve the local tag explicitly; this script will not overwrite it." >&2
  exit 1
fi

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
    open_run_url "$existing_release_run_url"
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
    open_run_url "$active_release_run_url"
    exit 0
  fi

  release_event="workflow_dispatch"
else
  release_event="push"
fi

secret_names="$(gh secret list --repo "$REPO_SLUG" --json name --jq '.[].name')"
variable_names="$(gh variable list --repo "$REPO_SLUG" --json name --jq '.[].name')"

has_name() {
  local names="$1"
  local wanted="$2"
  grep -Fqx "$wanted" <<<"$names"
}

require_secret() {
  local name="$1"
  if ! has_name "$secret_names" "$name"; then
    echo "Missing required release secret: $name" >&2
    exit 1
  fi
}

require_variable() {
  local name="$1"
  if ! has_name "$variable_names" "$name"; then
    echo "Missing required release variable: $name" >&2
    exit 1
  fi
}

require_secret_pair() {
  local primary="$1"
  local fallback="$2"
  if ! has_name "$secret_names" "$primary" && ! has_name "$secret_names" "$fallback"; then
    echo "Missing required release secret: $primary (or $fallback)" >&2
    exit 1
  fi
}

echo "==> Validating release signing and publication configuration"
require_secret_pair MACOS_CERTIFICATE_BASE64 APPLE_CERTIFICATE_BASE64
require_secret_pair MACOS_CERTIFICATE_PASSWORD APPLE_CERTIFICATE_PASSWORD
require_secret_pair MACOS_SIGNING_IDENTITY APPLE_SIGNING_IDENTITY

if has_name "$secret_names" MACOS_API_KEY_BASE64 && \
   has_name "$secret_names" MACOS_API_KEY_ID && \
   has_name "$secret_names" MACOS_API_ISSUER; then
  :
elif has_name "$secret_names" APPLE_ID && \
     has_name "$secret_names" APPLE_APP_SPECIFIC_PASSWORD && \
     has_name "$secret_names" APPLE_TEAM_ID; then
  :
else
  echo "Missing complete macOS notarization credentials." >&2
  exit 1
fi

require_secret WINDOWS_CERTIFICATE_BASE64
require_secret WINDOWS_CERTIFICATE_PASSWORD
require_secret_pair R2_ACCESS_KEY_ID CF_R2_ACCESS_KEY_ID
require_secret_pair R2_SECRET_ACCESS_KEY CF_R2_SECRET_ACCESS_KEY
require_variable CLOUDFLARE_ACCOUNT_ID
require_variable R2_BUCKET_NAME
require_variable UPDATE_BASE_URL
echo "Release configuration names are present."

verified_ci_run_id="$(
  gh run list \
    --repo "$REPO_SLUG" \
    --workflow "$CI_WORKFLOW" \
    --commit "$candidate_sha" \
    --limit 50 \
    --json databaseId,headSha,event,status,conclusion \
    --jq "[.[] | select(.headSha == \"$candidate_sha\" and (.event == \"push\" or .event == \"workflow_dispatch\") and .status == \"completed\" and .conclusion == \"success\")][0].databaseId // empty"
)"
if [[ -z "$verified_ci_run_id" ]]; then
  ci_run_id="$(
    gh run list \
      --repo "$REPO_SLUG" \
      --workflow "$CI_WORKFLOW" \
      --commit "$candidate_sha" \
      --limit 50 \
      --json databaseId,headSha,event,status \
      --jq "[.[] | select(.headSha == \"$candidate_sha\" and (.event == \"push\" or .event == \"workflow_dispatch\") and .status != \"completed\")][0].databaseId // empty"
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
release_previous_ids="$(gh run list --repo "$REPO_SLUG" --workflow "$RELEASE_WORKFLOW" --event "$release_event" --limit 100 --json databaseId --jq '.[].databaseId')"

echo
echo "==> Starting GitHub release for exact candidate $candidate_sha"
if [[ "$remote_tag_sha" == "$candidate_sha" ]]; then
  echo "Tag already points at the verified candidate; dispatching the release workflow explicitly."
  gh workflow run "$RELEASE_WORKFLOW" --repo "$REPO_SLUG" --ref "$tag" -f "tag=$tag"
else
  if [[ -z "$local_tag_sha" ]]; then
    git -C "$REPO_DIR" tag "$tag" "$candidate_sha"
  fi
  git -C "$REPO_DIR" push origin "refs/tags/$tag"
fi

release_run_id="$(wait_for_new_run "$RELEASE_WORKFLOW" "$release_event" "$candidate_sha" "$release_previous_ids")"
release_run_url="https://github.com/$REPO_SLUG/actions/runs/$release_run_id"
echo
echo "Release started: $release_run_url"
echo "CI evidence validation, release build, and publish will continue on GitHub."
open_run_url "$release_run_url"
