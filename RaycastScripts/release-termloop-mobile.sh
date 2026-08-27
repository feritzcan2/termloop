#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Release TermLoop Mobile
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🚀
# @raycast.packageName TermLoop
# @raycast.needsConfirmation true
# @raycast.refreshTime 0

# Documentation:
# @raycast.description Verify clients/mobile from current main, archive it locally, and upload it to TestFlight.
# @raycast.author feritzcan

set -euo pipefail

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

if [[ -d "$HOME/.nvm/versions/node" ]]; then
  for node_bin in "$HOME"/.nvm/versions/node/*/bin; do
    [[ -d "$node_bin" ]] && export PATH="$node_bin:$PATH"
  done
fi

SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
MOBILE_DIR="$REPO_DIR/clients/mobile"
MOBILE_PACKAGE="$MOBILE_DIR/package.json"
APP_CONFIG="$MOBILE_DIR/app.json"
DRY_RUN="${TERMLOOP_MOBILE_DRY_RUN:-0}"
release_dir=""
app_info_plist="$MOBILE_DIR/ios/TermLoop/Info.plist"
app_info_backup=""
freeze_marker=""
freeze_owner="raycast-mobile-release-$$"

cleanup() {
  if [[ -n "$app_info_backup" && -f "$app_info_backup" && -f "$app_info_plist" ]]; then
    cp "$app_info_backup" "$app_info_plist"
    rm -f "$app_info_backup"
  fi
  if [[ -n "$release_dir" && "$release_dir" == /tmp/termloop-mobile-testflight.* && -d "$release_dir" ]]; then
    rm -rf "$release_dir"
    echo "Removed temporary release directory: $release_dir"
  fi
  if [[ -n "$freeze_marker" && -f "$freeze_marker" ]] && grep -Fqx "$freeze_owner" "$freeze_marker"; then
    rm "$freeze_marker"
  fi
}

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

for command in git node pnpm python3 xcodebuild plutil security codesign; do
  need_command "$command"
done

if [[ ! -f "$MOBILE_PACKAGE" || ! -f "$APP_CONFIG" ]]; then
  echo "TermLoop mobile source not found under: $MOBILE_DIR"
  exit 1
fi

package_name="$(node -p "require('$MOBILE_PACKAGE').name")"
if [[ "$package_name" != "@termloop/mobile" ]]; then
  echo "Refusing unexpected mobile package: $package_name"
  exit 1
fi

branch="$(git -C "$REPO_DIR" branch --show-current)"
if [[ "$branch" != "main" ]]; then
  echo "Release requires the designated TermLoop main checkout; current branch is '$branch'."
  exit 1
fi

if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
  echo "Release requires a clean TermLoop main checkout."
  git -C "$REPO_DIR" status --short
  exit 1
fi

version="$(node -p "require('$APP_CONFIG').expo.version")"
bundle_id="$(node -p "require('$APP_CONFIG').expo.ios.bundleIdentifier")"
build_number="$(date -u +%Y%m%d%H%M%S)"
team_id="${TERMLOOP_APPLE_TEAM_ID:-}"

if [[ -z "$team_id" ]]; then
  project_file="$MOBILE_DIR/ios/TermLoop.xcodeproj/project.pbxproj"
  if [[ -f "$project_file" ]]; then
    team_id="$(sed -nE 's/.*DEVELOPMENT_TEAM = ([A-Z0-9]{10});.*/\1/p' "$project_file" | sort -u | head -1)"
  fi
fi

if [[ -z "$team_id" ]]; then
  echo "Could not determine the Apple team. Set TERMLOOP_APPLE_TEAM_ID."
  exit 1
fi

echo "Repository: $REPO_DIR"
echo "Package:    $package_name"
echo "Version:    $version ($build_number)"
echo "Bundle ID:  $bundle_id"
echo "Apple team: $team_id"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY RUN: would verify clients/mobile, archive its Release build, and upload it to TestFlight."
  exit 0
fi

freeze_marker="$(git -C "$REPO_DIR" rev-parse --absolute-git-dir)/termloop-release-freeze"
if [[ -e "$freeze_marker" ]]; then
  echo "Another TermLoop release is already active: $freeze_marker"
  exit 1
fi
printf '%s\n' "$freeze_owner" > "$freeze_marker"
trap cleanup EXIT

echo "==> Fetching origin/main"
git -C "$REPO_DIR" fetch origin --prune --no-tags \
  '+refs/heads/main:refs/remotes/origin/main'

local_main="$(git -C "$REPO_DIR" rev-parse main)"
remote_main="$(git -C "$REPO_DIR" rev-parse origin/main)"
if [[ "$local_main" != "$remote_main" ]]; then
  echo "Local main ($local_main) does not match origin/main ($remote_main)."
  exit 1
fi

cd "$REPO_DIR"

echo "==> Verifying TermLoop Mobile"
pnpm --filter @termloop/mobile check
pnpm --filter @termloop/mobile test
pnpm --filter @termloop/mobile export:ios

if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
  echo "TermLoop changed while the release verification was running."
  git -C "$REPO_DIR" status --short
  exit 1
fi

echo "==> Regenerating native iOS project"
pnpm --filter @termloop/mobile exec expo prebuild --platform ios --clean

# app.json writes a fixed CFBundleVersion into the generated Info.plist.
# Override that generated value for this archive so every TestFlight upload
# receives the unique build number computed above.
if [[ ! -f "$app_info_plist" ]]; then
  echo "Generated app Info.plist is missing: $app_info_plist"
  exit 1
fi
app_info_backup="$(mktemp /tmp/termloop-mobile-info.XXXXXX)"
cp "$app_info_plist" "$app_info_backup"
plutil -replace CFBundleVersion -string "$build_number" "$app_info_plist"

# Some Expo config plugins remove the microphone key when microphone capture is
# disabled for the camera plugin. App Store Connect still requires the privacy
# purpose string when any linked native framework references microphone APIs.
if plutil -extract NSMicrophoneUsageDescription raw "$app_info_plist" >/dev/null 2>&1; then
  plutil -replace NSMicrophoneUsageDescription -string "TermLoop uses the microphone only when you choose to send audio to a TermLoop agent." "$app_info_plist"
else
  plutil -insert NSMicrophoneUsageDescription -string "TermLoop uses the microphone only when you choose to send audio to a TermLoop agent." "$app_info_plist"
fi

workspace="$MOBILE_DIR/ios/TermLoop.xcworkspace"
if [[ ! -d "$workspace" ]]; then
  echo "Generated TermLoop Xcode workspace is missing: $workspace"
  exit 1
fi

scheme="TermLoop"
if ! xcodebuild -list -json -workspace "$workspace" | python3 -c '
import json, sys
data = json.load(sys.stdin)
schemes = data.get("workspace", {}).get("schemes", [])
if "TermLoop" not in schemes:
    raise SystemExit(1)
'; then
  echo "The generated workspace does not contain the TermLoop scheme."
  exit 1
fi

release_dir="$(mktemp -d /tmp/termloop-mobile-testflight.XXXXXX)"
archive_path="$release_dir/TermLoop.xcarchive"
export_path="$release_dir/export"
export_options="$release_dir/ExportOptions.plist"

echo "==> Archiving $scheme"
xcodebuild archive \
  -workspace "$workspace" \
  -scheme "$scheme" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$team_id" \
  CODE_SIGN_STYLE=Automatic \
  MARKETING_VERSION="$version" \
  CURRENT_PROJECT_VERSION="$build_number"

archive_info="$archive_path/Info.plist"
app_path="$(find "$archive_path/Products/Applications" -maxdepth 1 -name '*.app' -print -quit)"
if [[ ! -f "$archive_info" || -z "$app_path" ]]; then
  echo "Archive is missing its Info.plist or signed app."
  exit 1
fi

archived_bundle_id="$(plutil -extract ApplicationProperties.CFBundleIdentifier raw "$archive_info")"
archived_version="$(plutil -extract ApplicationProperties.CFBundleShortVersionString raw "$archive_info")"
archived_build="$(plutil -extract ApplicationProperties.CFBundleVersion raw "$archive_info")"
if [[ "$archived_bundle_id" != "$bundle_id" || "$archived_version" != "$version" || "$archived_build" != "$build_number" ]]; then
  echo "Archive identity mismatch: $archived_bundle_id $archived_version ($archived_build)"
  exit 1
fi

echo "==> Inspecting signed entitlements"
codesign -d --entitlements :- "$app_path"

plutil -create xml1 "$export_options"
plutil -insert destination -string upload "$export_options"
plutil -insert method -string app-store-connect "$export_options"
plutil -insert signingStyle -string automatic "$export_options"
plutil -insert teamID -string "$team_id" "$export_options"
plutil -insert manageAppVersionAndBuildNumber -bool false "$export_options"
plutil -insert uploadSymbols -bool true "$export_options"

echo "==> Uploading to TestFlight"
xcodebuild -exportArchive \
  -archivePath "$archive_path" \
  -exportPath "$export_path" \
  -exportOptionsPlist "$export_options" \
  -allowProvisioningUpdates

echo
echo "Upload succeeded for TermLoop Mobile $version ($build_number)."
echo "App Store Connect may still be processing the build."
