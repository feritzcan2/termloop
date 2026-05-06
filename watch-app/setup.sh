#!/bin/bash
# Generates the TermLoopWatch.xcodeproj from project.yml and opens it.
# Run from the watch-app/ directory.

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v xcodegen >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "==> Installing xcodegen via Homebrew..."
    brew install xcodegen
  else
    echo "Error: xcodegen not found and Homebrew is not installed." >&2
    echo "Install xcodegen first: https://github.com/yonaskolb/XcodeGen" >&2
    exit 1
  fi
fi

echo "==> Generating Xcode project..."
xcodegen generate

echo "==> Done. Opening project..."
open TermLoopWatch.xcodeproj

cat <<'EOF'

Next steps:
  1. In Xcode, select the TermLoopWatch target → Signing & Capabilities.
     Pick your Apple Developer Team. (Free Apple ID works for simulator-only.)
  2. If you want to run on Watch simulator: Xcode → Settings → Platforms,
     install "watchOS Simulator" runtime if missing.
  3. Run the iOS app on iPhone simulator (or device). Enter Mac's host/port/
     password and tap "Test connection".
  4. For Watch testing on real devices, your bundle ID must be registered in
     Apple Developer with Push Notifications capability — see README.md.
EOF
