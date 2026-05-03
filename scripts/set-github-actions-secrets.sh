#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/set-github-actions-secrets.sh [--repo owner/name] [--env-file path]

Reads required GitHub Actions secrets from the current environment or an env file
and uploads them to the target GitHub repository via `gh secret set`.

Required secrets:
  SPARKLE_PRIVATE_KEY
  APPLE_CERTIFICATE_BASE64
  APPLE_CERTIFICATE_PASSWORD
  APPLE_SIGNING_IDENTITY
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID

Optional:
  SENTRY_AUTH_TOKEN

Examples:
  scripts/set-github-actions-secrets.sh --repo feritzcan2/termloop --env-file ~/release-secrets.env
  source ~/release-secrets.env && scripts/set-github-actions-secrets.sh --repo feritzcan2/termloop
EOF
}

REPO=""
ENV_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Env file not found: $ENV_FILE" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "$REPO" ]]; then
  REPO="$(git remote get-url origin 2>/dev/null | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
fi

if [[ -z "$REPO" ]]; then
  echo "Could not determine target repo. Pass --repo owner/name." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "`gh` is required." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  cat >&2 <<EOF
GitHub CLI is not authenticated.

Run:
  gh auth login -h github.com

Then rerun this script.
EOF
  exit 1
fi

required=(
  SPARKLE_PRIVATE_KEY
  APPLE_CERTIFICATE_BASE64
  APPLE_CERTIFICATE_PASSWORD
  APPLE_SIGNING_IDENTITY
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
)

optional=(
  SENTRY_AUTH_TOKEN
)

missing=()
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    missing+=("$key")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf 'Missing required values:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

set_secret() {
  local key="$1"
  local value="$2"
  printf '%s' "$value" | gh secret set "$key" --repo "$REPO"
}

echo "Uploading required secrets to $REPO"
for key in "${required[@]}"; do
  set_secret "$key" "${!key}"
done

for key in "${optional[@]}"; do
  if [[ -n "${!key:-}" ]]; then
    set_secret "$key" "${!key}"
  fi
done

echo "GitHub Actions secrets updated for $REPO"
