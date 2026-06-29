#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/submit-testflight.sh [options]

Commits the current repository state, creates a local iOS Release archive with
Xcode, and uploads it to TestFlight through App Store Connect.

Options:
  --message <message>       Git commit message.
  --bump-version <kind>     Bump app/package version before committing.
                             kind: patch, minor, major, or an explicit x.y.z.
  --build-number <number>   CFBundleVersion for this upload. Default: timestamp.
  --skip-typecheck          Skip npm run typecheck.
  --no-commit               Do not create a git commit before archiving.
  --push                    Push the current branch after committing.
  --skip-upload             Export a signed .ipa locally instead of uploading.
  -h, --help                Show this help.

Examples:
  npm run testflight
  npm run testflight -- --message "chore: ship voice agent mobile build"
  npm run testflight -- --bump-version patch
  npm run testflight -- --build-number 202606291400
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(git -C "$APP_DIR" rev-parse --show-toplevel)"
IOS_DIR="$APP_DIR/ios"
INFO_PLIST="$IOS_DIR/TermLoopMobile/Info.plist"
WORKSPACE="$IOS_DIR/TermLoopMobile.xcworkspace"
SCHEME="TermLoopMobile"
TEAM_ID="S9QXLS2NJ2"

COMMIT_MESSAGE="chore: ship TermLoop Mobile TestFlight build"
BUMP_VERSION=""
BUILD_NUMBER="$(date +%Y%m%d%H%M)"
RUN_TYPECHECK=1
CREATE_COMMIT=1
PUSH_BRANCH=0
UPLOAD=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --message|-m)
      COMMIT_MESSAGE="${2:-}"
      [[ -n "$COMMIT_MESSAGE" ]] || { echo "Missing value for --message" >&2; exit 2; }
      shift 2
      ;;
    --bump-version)
      BUMP_VERSION="${2:-}"
      [[ -n "$BUMP_VERSION" ]] || { echo "Missing value for --bump-version" >&2; exit 2; }
      shift 2
      ;;
    --build-number)
      BUILD_NUMBER="${2:-}"
      [[ -n "$BUILD_NUMBER" ]] || { echo "Missing value for --build-number" >&2; exit 2; }
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
    --skip-upload)
      UPLOAD=0
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

if [[ ! "$BUILD_NUMBER" =~ ^[0-9]+([.][0-9]+){0,2}$ ]]; then
  echo "Build number must contain only digits and up to two dots: $BUILD_NUMBER" >&2
  exit 2
fi

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 2
  fi
}

require_tool git
require_tool npm
require_tool node
require_tool plutil
require_tool xcodebuild

echo "Repository:   $REPO_ROOT"
echo "Mobile app:   $APP_DIR"
echo "Xcode scheme: $SCHEME"
echo "Apple team:   $TEAM_ID"

if [[ -n "$BUMP_VERSION" ]]; then
  echo "Bumping mobile version: $BUMP_VERSION"
fi

APP_VERSION="$(node - "$APP_DIR" "$BUMP_VERSION" <<'NODE'
const fs = require("fs");
const path = require("path");

const appDir = process.argv[2];
const bump = process.argv[3];
const appJsonPath = path.join(appDir, "app.json");
const packageJsonPath = path.join(appDir, "package.json");
const packageLockPath = path.join(appDir, "package-lock.json");

const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));
const current = appJson.expo && appJson.expo.version;
if (!current || !/^\d+\.\d+\.\d+$/.test(current)) {
  throw new Error(`Unsupported expo.version: ${current}`);
}

let next = current;
if (bump) {
  next = bump;
  if (["patch", "minor", "major"].includes(bump)) {
    const parts = current.split(".").map(Number);
    if (bump === "patch") parts[2] += 1;
    if (bump === "minor") {
      parts[1] += 1;
      parts[2] = 0;
    }
    if (bump === "major") {
      parts[0] += 1;
      parts[1] = 0;
      parts[2] = 0;
    }
    next = parts.join(".");
  }
  if (!/^\d+\.\d+\.\d+$/.test(next)) {
    throw new Error(`Invalid target version: ${next}`);
  }

  appJson.expo.version = next;
  fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  packageJson.version = next;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  if (fs.existsSync(packageLockPath)) {
    const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
    packageLock.version = next;
    if (packageLock.packages && packageLock.packages[""]) {
      packageLock.packages[""].version = next;
    }
    fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  }
}

console.log(next);
NODE
)"

echo "Syncing native iOS version: $APP_VERSION ($BUILD_NUMBER)"
plutil -replace CFBundleShortVersionString -string "$APP_VERSION" "$INFO_PLIST"
plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "$INFO_PLIST"

if [[ "$RUN_TYPECHECK" -eq 1 ]]; then
  echo "Running mobile typecheck..."
  npm --prefix "$APP_DIR" run typecheck
fi

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

BUILD_ROOT="$IOS_DIR/build/testflight"
ARCHIVE_PATH="$BUILD_ROOT/TermLoopMobile-${APP_VERSION}-${BUILD_NUMBER}.xcarchive"
EXPORT_PATH="$BUILD_ROOT/export-${APP_VERSION}-${BUILD_NUMBER}"
EXPORT_OPTIONS="$BUILD_ROOT/ExportOptions-${APP_VERSION}-${BUILD_NUMBER}.plist"
DESTINATION="upload"
if [[ "$UPLOAD" -eq 0 ]]; then
  DESTINATION="export"
fi

mkdir -p "$BUILD_ROOT"

cat > "$EXPORT_OPTIONS" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key>
  <string>$DESTINATION</string>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>$TEAM_ID</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
EOF

echo "Creating local iOS archive..."
xcodebuild archive \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  MARKETING_VERSION="$APP_VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER"

if [[ "$UPLOAD" -eq 1 ]]; then
  echo "Uploading archive to App Store Connect/TestFlight..."
else
  echo "Exporting signed IPA locally..."
fi

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates

echo "Archive: $ARCHIVE_PATH"
echo "Export:  $EXPORT_PATH"
