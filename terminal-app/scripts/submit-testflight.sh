#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/submit-testflight.sh [options]

Commits the current repository state and sends a TermLoop Mobile iOS build to
TestFlight through EAS.

Options:
  --profile <name>       EAS build profile to use. Default: staging.
  --message <message>    Git commit message.
  --skip-typecheck       Skip npm run typecheck.
  --no-commit            Do not create a git commit before building.
  --push                 Push the current branch after committing.
  --interactive          Allow EAS prompts. Default is --non-interactive.
  -h, --help             Show this help.

Examples:
  npm run testflight
  npm run testflight -- --message "chore: ship voice agent mobile build"
  npm run testflight -- --profile production --push
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(git -C "$APP_DIR" rev-parse --show-toplevel)"

PROFILE="staging"
COMMIT_MESSAGE="chore: ship TermLoop Mobile TestFlight build"
RUN_TYPECHECK=1
CREATE_COMMIT=1
PUSH_BRANCH=0
EAS_INTERACTIVE_FLAG="--non-interactive"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      [[ -n "$PROFILE" ]] || { echo "Missing value for --profile" >&2; exit 2; }
      shift 2
      ;;
    --message|-m)
      COMMIT_MESSAGE="${2:-}"
      [[ -n "$COMMIT_MESSAGE" ]] || { echo "Missing value for --message" >&2; exit 2; }
      shift 2
      ;;
    --skip-typecheck)
      RUN_TYPECHECK=0
      shift
      ;;
    --no-commit)
      CREATE_COMMIT=0
      shift
      ;;
    --push)
      PUSH_BRANCH=1
      shift
      ;;
    --interactive)
      EAS_INTERACTIVE_FLAG=""
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$PROFILE" in
  staging|production) ;;
  *)
    echo "Profile '$PROFILE' is not a store/TestFlight profile. Use staging or production." >&2
    exit 2
    ;;
esac

echo "Repository: $REPO_ROOT"
echo "Mobile app:  $APP_DIR"
echo "EAS profile: $PROFILE"

if [[ "$RUN_TYPECHECK" -eq 1 ]]; then
  echo "Running mobile typecheck..."
  npm --prefix "$APP_DIR" run typecheck
fi

echo "Checking EAS authentication..."
npx --prefix "$APP_DIR" eas-cli whoami >/dev/null

if [[ "$CREATE_COMMIT" -eq 1 ]]; then
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
    echo "Committing local repository changes..."
    git -C "$REPO_ROOT" add -A
    git -C "$REPO_ROOT" commit -m "$COMMIT_MESSAGE"
  else
    echo "No local changes to commit."
  fi
fi

if [[ "$PUSH_BRANCH" -eq 1 ]]; then
  branch="$(git -C "$REPO_ROOT" branch --show-current)"
  [[ -n "$branch" ]] || { echo "Cannot push: detached HEAD." >&2; exit 2; }
  echo "Pushing branch '$branch'..."
  git -C "$REPO_ROOT" push -u origin "$branch"
fi

echo "Starting EAS iOS build with auto-submit..."
cd "$APP_DIR"
npx eas-cli build \
  --profile "$PROFILE" \
  --platform ios \
  --auto-submit \
  ${EAS_INTERACTIVE_FLAG:+"$EAS_INTERACTIVE_FLAG"}
