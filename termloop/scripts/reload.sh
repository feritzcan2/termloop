#!/usr/bin/env bash
set -euo pipefail

APP_NAME="TermLoop DEV"
BUNDLE_ID="com.termloop.app.debug"
BASE_APP_NAME="TermLoop DEV"
DERIVED_DATA=""
NAME_SET=0
BUNDLE_SET=0
DERIVED_SET=0
TAG=""
LAUNCH=0
TERMLOOP_DEBUG_LOG=""
CLI_PATH=""
LAST_SOCKET_PATH_DIR="$HOME/Library/Application Support/TermLoop"
LAST_SOCKET_PATH_FILE="${LAST_SOCKET_PATH_DIR}/last-socket-path"
AUTO_SKIP_ZIG_BUILD_REASON=""

should_skip_ghostty_cli_helper_zig_build() {
  if [[ "${TERMLOOP_SKIP_ZIG_BUILD:-}" == "1" ]]; then
    AUTO_SKIP_ZIG_BUILD_REASON="TERMLOOP_SKIP_ZIG_BUILD=1"
    return 0
  fi

  local product_version zig_version major_version
  product_version="$(sw_vers -productVersion 2>/dev/null || true)"
  zig_version="$(zig version 2>/dev/null || true)"
  major_version="${product_version%%.*}"

  if [[ "$zig_version" == "0.15.2" ]] && [[ "$major_version" =~ ^[0-9]+$ ]] && (( major_version >= 26 )); then
    AUTO_SKIP_ZIG_BUILD_REASON="macOS ${product_version} + zig ${zig_version}"
    return 0
  fi

  AUTO_SKIP_ZIG_BUILD_REASON=""
  return 1
}

write_dev_cli_shim() {
  local target="$1"
  local fallback_bin="$2"
  mkdir -p "$(dirname "$target")"
  cat > "$target" <<EOF
#!/usr/bin/env bash
# termloop dev shim (managed by scripts/reload.sh)
set -euo pipefail

CLI_PATH_FILE="/tmp/termloop-last-cli-path"
CLI_PATH_OWNER="\$(stat -f '%u' "\$CLI_PATH_FILE" 2>/dev/null || stat -c '%u' "\$CLI_PATH_FILE" 2>/dev/null || echo -1)"
if [[ -r "\$CLI_PATH_FILE" ]] && [[ ! -L "\$CLI_PATH_FILE" ]] && [[ "\$CLI_PATH_OWNER" == "\$(id -u)" ]]; then
  CLI_PATH="\$(cat "\$CLI_PATH_FILE")"
  if [[ -x "\$CLI_PATH" ]]; then
    exec "\$CLI_PATH" "\$@"
  fi
fi

if [[ -x "$fallback_bin" ]]; then
  exec "$fallback_bin" "\$@"
fi

echo "error: no reload-selected dev TermLoop CLI found. Run ./scripts/reload.sh --tag <name> first." >&2
exit 1
EOF
  chmod +x "$target"
}

select_termloop_shim_target() {
  local app_cli_dir="/Applications/TermLoop.app/Contents/Resources/bin"
  local marker="termloop dev shim (managed by scripts/reload.sh)"
  local target=""
  local path_entry=""
  local candidate=""

  IFS=':' read -r -a path_entries <<< "${PATH:-}"
  for path_entry in "${path_entries[@]}"; do
    [[ -z "$path_entry" ]] && continue
    if [[ "$path_entry" == "~/"* ]]; then
      path_entry="$HOME/${path_entry#~/}"
    fi
    if [[ "$path_entry" == "$app_cli_dir" ]]; then
      break
    fi
    [[ -d "$path_entry" && -w "$path_entry" ]] || continue
    candidate="$path_entry/termloop"
    if [[ ! -e "$candidate" ]]; then
      target="$candidate"
      break
    fi
    if [[ -f "$candidate" ]] && grep -q "$marker" "$candidate" 2>/dev/null; then
      target="$candidate"
      break
    fi
  done

  if [[ -n "$target" ]]; then
    echo "$target"
    return 0
  fi

  # Fallback for PATH layouts where app CLI isn't listed or no earlier entries were writable.
  for path_entry in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
    [[ -d "$path_entry" && -w "$path_entry" ]] || continue
    candidate="$path_entry/termloop"
    if [[ ! -e "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
    if [[ -f "$candidate" ]] && grep -q "$marker" "$candidate" 2>/dev/null; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

write_last_socket_path() {
  local socket_path="$1"
  mkdir -p "$LAST_SOCKET_PATH_DIR"
  echo "$socket_path" > "$LAST_SOCKET_PATH_FILE" || true
  echo "$socket_path" > /tmp/termloop-last-socket-path || true
}

usage() {
  cat <<'EOF'
Usage: ./scripts/reload.sh --tag <name> [options]

Options:
  --tag <name>           Required. Short tag for parallel builds (e.g., feature-xyz-lol).
                         Sets app name, bundle id, and derived data path unless overridden.
  --launch               Launch the app after building. Without this flag, the script
                         builds and prints the app path but does not open it.
  --name <app name>      Override app display/bundle name.
  --bundle-id <id>       Override bundle identifier.
  --derived-data <path>  Override derived data path.
  -h, --help             Show this help.
EOF
}

sanitize_bundle() {
  local raw="$1"
  local cleaned
  cleaned="$(echo "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/./g; s/^\\.+//; s/\\.+$//; s/\\.+/./g')"
  if [[ -z "$cleaned" ]]; then
    cleaned="agent"
  fi
  echo "$cleaned"
}

sanitize_path() {
  local raw="$1"
  local cleaned
  cleaned="$(echo "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
  if [[ -z "$cleaned" ]]; then
    cleaned="agent"
  fi
  echo "$cleaned"
}

tagged_derived_data_path() {
  local slug="$1"
  echo "$HOME/Library/Developer/Xcode/DerivedData/termloop-${slug}"
}

print_tag_cleanup_reminder() {
  local current_slug="$1"
  local path=""
  local tag=""
  local seen=" "
  local -a stale_tags=()

  while IFS= read -r -d '' path; do
    if [[ "$path" == /tmp/termloop-* ]]; then
      tag="${path#/tmp/termloop-}"
    elif [[ "$path" == "$HOME/Library/Developer/Xcode/DerivedData/termloop-"* ]]; then
      tag="${path#$HOME/Library/Developer/Xcode/DerivedData/termloop-}"
    else
      continue
    fi
    if [[ "$tag" == "$current_slug" ]]; then
      continue
    fi
    # Only surface stale debug tag builds.
    if [[ ! -d "$path/Build/Products/Debug" ]]; then
      continue
    fi
    if [[ "$seen" == *" $tag "* ]]; then
      continue
    fi
    seen="${seen}${tag} "
    stale_tags+=("$tag")
  done < <(
    find /tmp -maxdepth 1 -name 'termloop-*' -print0 2>/dev/null
    find "$HOME/Library/Developer/Xcode/DerivedData" -maxdepth 1 -type d -name 'termloop-*' -print0 2>/dev/null
  )

  echo
  echo "Tag cleanup status:"
  echo "  current tag: ${current_slug} (keep this running until you verify)"
  if [[ "${#stale_tags[@]}" -eq 0 ]]; then
    echo "  stale tags: none"
    echo "  stale cleanup: not needed"
  else
    echo "  stale tags:"
    for tag in "${stale_tags[@]}"; do
      echo "    - ${tag}"
    done
    echo "Cleanup stale tags only:"
    for tag in "${stale_tags[@]}"; do
      echo "  pkill -f \"TermLoop DEV ${tag}.app/Contents/MacOS/TermLoop DEV\""
      echo "  rm -rf \"$(tagged_derived_data_path "$tag")\" \"/tmp/termloop-${tag}\" \"/tmp/termloop-debug-${tag}.sock\""
      echo "  rm -f \"/tmp/termloop-debug-${tag}.log\""
      echo "  rm -f \"$HOME/Library/Application Support/TermLoop/termloopd-dev-${tag}.sock\""
    done
  fi
  echo "After you verify current tag, cleanup command:"
  echo "  pkill -f \"TermLoop DEV ${current_slug}.app/Contents/MacOS/TermLoop DEV\""
  echo "  rm -rf \"$(tagged_derived_data_path "$current_slug")\" \"/tmp/termloop-${current_slug}\" \"/tmp/termloop-debug-${current_slug}.sock\""
  echo "  rm -f \"/tmp/termloop-debug-${current_slug}.log\""
  echo "  rm -f \"$HOME/Library/Application Support/TermLoop/termloopd-dev-${current_slug}.sock\""
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:-}"
      if [[ -z "$TAG" ]]; then
        echo "error: --tag requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --name)
      APP_NAME="${2:-}"
      if [[ -z "$APP_NAME" ]]; then
        echo "error: --name requires a value" >&2
        exit 1
      fi
      NAME_SET=1
      shift 2
      ;;
    --bundle-id)
      BUNDLE_ID="${2:-}"
      if [[ -z "$BUNDLE_ID" ]]; then
        echo "error: --bundle-id requires a value" >&2
        exit 1
      fi
      BUNDLE_SET=1
      shift 2
      ;;
    --launch)
      LAUNCH=1
      shift
      ;;
    --derived-data)
      DERIVED_DATA="${2:-}"
      if [[ -z "$DERIVED_DATA" ]]; then
        echo "error: --derived-data requires a value" >&2
        exit 1
      fi
      DERIVED_SET=1
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$TAG" ]]; then
  echo "error: --tag is required (example: ./scripts/reload.sh --tag fix-sidebar-theme)" >&2
  usage
  exit 1
fi

"$PWD/scripts/ensure-ghosttykit.sh"

if should_skip_ghostty_cli_helper_zig_build; then
  if [[ "${TERMLOOP_SKIP_ZIG_BUILD:-}" != "1" ]]; then
    echo "Auto-enabling TERMLOOP_SKIP_ZIG_BUILD=1 for Ghostty CLI helper (${AUTO_SKIP_ZIG_BUILD_REASON})"
  fi
  export TERMLOOP_SKIP_ZIG_BUILD=1
fi

if [[ -n "$TAG" ]]; then
  TAG_ID="$(sanitize_bundle "$TAG")"
  TAG_SLUG="$(sanitize_path "$TAG")"
  if [[ "$NAME_SET" -eq 0 ]]; then
    APP_NAME="TermLoop DEV ${TAG}"
  fi
  if [[ "$BUNDLE_SET" -eq 0 ]]; then
    BUNDLE_ID="com.termloop.app.debug.${TAG_ID}"
  fi
  if [[ "$DERIVED_SET" -eq 0 ]]; then
    DERIVED_DATA="$(tagged_derived_data_path "$TAG_SLUG")"
  fi
fi

XCODEBUILD_ARGS=(
  -project GhosttyTabs.xcodeproj
  -scheme termloop
  -configuration Debug
  -destination 'platform=macOS'
)
if [[ -n "$DERIVED_DATA" ]]; then
  XCODEBUILD_ARGS+=(-derivedDataPath "$DERIVED_DATA")
fi
if [[ -z "$TAG" ]]; then
  XCODEBUILD_ARGS+=(
    INFOPLIST_KEY_CFBundleName="$APP_NAME"
    INFOPLIST_KEY_CFBundleDisplayName="$APP_NAME"
    PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID"
  )
fi
# Forward TERMLOOP_SKIP_ZIG_BUILD to xcodebuild run script phases (e.g. macOS
# Tahoe where zig 0.15.2 can't link the ghostty CLI helper).
if [[ "${TERMLOOP_SKIP_ZIG_BUILD:-}" == "1" ]]; then
  XCODEBUILD_ARGS+=(TERMLOOP_SKIP_ZIG_BUILD=1)
fi
XCODEBUILD_ARGS+=(build)

XCODE_LOG="/tmp/termloop-xcodebuild-${TAG_SLUG}.log"
set +e
xcodebuild "${XCODEBUILD_ARGS[@]}" 2>&1 | tee "$XCODE_LOG" | grep -E '(warning:|error:|fatal:|BUILD FAILED|BUILD SUCCEEDED|\*\* BUILD)'
XCODE_PIPESTATUS=("${PIPESTATUS[@]}")
set -e
XCODE_EXIT="${XCODE_PIPESTATUS[0]}"
echo "Full build log: $XCODE_LOG"
if [[ "$XCODE_EXIT" -ne 0 ]]; then
  echo "error: xcodebuild failed with exit code $XCODE_EXIT" >&2
  exit "$XCODE_EXIT"
fi
sleep 0.2

FALLBACK_APP_NAME="$BASE_APP_NAME"
SEARCH_APP_NAME="$APP_NAME"
if [[ -n "$TAG" ]]; then
  SEARCH_APP_NAME="$BASE_APP_NAME"
fi
if [[ -n "$DERIVED_DATA" ]]; then
  APP_PATH="${DERIVED_DATA}/Build/Products/Debug/${SEARCH_APP_NAME}.app"
  if [[ ! -d "${APP_PATH}" && "$SEARCH_APP_NAME" != "$FALLBACK_APP_NAME" ]]; then
    APP_PATH="${DERIVED_DATA}/Build/Products/Debug/${FALLBACK_APP_NAME}.app"
  fi
else
  APP_BINARY="$(
    find "$HOME/Library/Developer/Xcode/DerivedData" -path "*/Build/Products/Debug/${SEARCH_APP_NAME}.app/Contents/MacOS/${SEARCH_APP_NAME}" -print0 \
    | xargs -0 /usr/bin/stat -f "%m %N" 2>/dev/null \
    | sort -nr \
    | head -n 1 \
    | cut -d' ' -f2-
  )"
  if [[ -n "${APP_BINARY}" ]]; then
    APP_PATH="$(dirname "$(dirname "$(dirname "$APP_BINARY")")")"
  fi
  if [[ -z "${APP_PATH}" && "$SEARCH_APP_NAME" != "$FALLBACK_APP_NAME" ]]; then
    APP_BINARY="$(
      find "$HOME/Library/Developer/Xcode/DerivedData" -path "*/Build/Products/Debug/${FALLBACK_APP_NAME}.app/Contents/MacOS/${FALLBACK_APP_NAME}" -print0 \
      | xargs -0 /usr/bin/stat -f "%m %N" 2>/dev/null \
      | sort -nr \
      | head -n 1 \
      | cut -d' ' -f2-
    )"
    if [[ -n "${APP_BINARY}" ]]; then
      APP_PATH="$(dirname "$(dirname "$(dirname "$APP_BINARY")")")"
    fi
  fi
fi
if [[ -z "${APP_PATH}" || ! -d "${APP_PATH}" ]]; then
  echo "${APP_NAME}.app not found in DerivedData" >&2
  exit 1
fi

if [[ -n "${TAG_SLUG:-}" ]]; then
  TMP_COMPAT_DERIVED_LINK="/tmp/termloop-${TAG_SLUG}"
  if [[ "$DERIVED_DATA" != "$TMP_COMPAT_DERIVED_LINK" ]]; then
    ABS_DERIVED_DATA="$(cd "$DERIVED_DATA" && pwd)"
    rm -rf "$TMP_COMPAT_DERIVED_LINK"
    ln -s "$ABS_DERIVED_DATA" "$TMP_COMPAT_DERIVED_LINK"
  fi
fi

if [[ -n "$TAG" && "$APP_NAME" != "$SEARCH_APP_NAME" ]]; then
  TAG_APP_PATH="$(dirname "$APP_PATH")/${APP_NAME}.app"
  rm -rf "$TAG_APP_PATH"
  cp -R "$APP_PATH" "$TAG_APP_PATH"
  INFO_PLIST="$TAG_APP_PATH/Contents/Info.plist"
  if [[ -f "$INFO_PLIST" ]]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$INFO_PLIST" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Add :CFBundleName string $APP_NAME" "$INFO_PLIST"
    /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$INFO_PLIST" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $APP_NAME" "$INFO_PLIST"
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$INFO_PLIST" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$INFO_PLIST"
    if [[ -n "${TAG_SLUG:-}" ]]; then
      APP_SUPPORT_DIR="$HOME/Library/Application Support/TermLoop"
      TERMLOOPD_SOCKET="${APP_SUPPORT_DIR}/termloopd-dev-${TAG_SLUG}.sock"
      TERMLOOP_SOCKET="/tmp/termloop-debug-${TAG_SLUG}.sock"
      TERMLOOP_DEBUG_LOG="/tmp/termloop-debug-${TAG_SLUG}.log"
      write_last_socket_path "$TERMLOOP_SOCKET"
      echo "$TERMLOOP_DEBUG_LOG" > /tmp/termloop-last-debug-log-path || true
      /usr/libexec/PlistBuddy -c "Add :LSEnvironment dict" "$INFO_PLIST" 2>/dev/null || true
      /usr/libexec/PlistBuddy -c "Set :LSEnvironment:TERMLOOPD_UNIX_PATH \"${TERMLOOPD_SOCKET}\"" "$INFO_PLIST" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :LSEnvironment:TERMLOOPD_UNIX_PATH string \"${TERMLOOPD_SOCKET}\"" "$INFO_PLIST"
      /usr/libexec/PlistBuddy -c "Set :LSEnvironment:TERMLOOP_SOCKET_PATH \"${TERMLOOP_SOCKET}\"" "$INFO_PLIST" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :LSEnvironment:TERMLOOP_SOCKET_PATH string \"${TERMLOOP_SOCKET}\"" "$INFO_PLIST"
      /usr/libexec/PlistBuddy -c "Set :LSEnvironment:TERMLOOP_DEBUG_LOG \"${TERMLOOP_DEBUG_LOG}\"" "$INFO_PLIST" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :LSEnvironment:TERMLOOP_DEBUG_LOG string \"${TERMLOOP_DEBUG_LOG}\"" "$INFO_PLIST"
      /usr/libexec/PlistBuddy -c "Set :LSEnvironment:TERMLOOP_SOCKET_ENABLE 1" "$INFO_PLIST" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :LSEnvironment:TERMLOOP_SOCKET_ENABLE string 1" "$INFO_PLIST"
      /usr/libexec/PlistBuddy -c "Set :LSEnvironment:TERMLOOP_SOCKET_MODE allowAll" "$INFO_PLIST" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :LSEnvironment:TERMLOOP_SOCKET_MODE string allowAll" "$INFO_PLIST"
      /usr/libexec/PlistBuddy -c "Set :LSEnvironment:TERMLOOP_REMOTE_DAEMON_ALLOW_LOCAL_BUILD 1" "$INFO_PLIST" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :LSEnvironment:TERMLOOP_REMOTE_DAEMON_ALLOW_LOCAL_BUILD string 1" "$INFO_PLIST"
      /usr/libexec/PlistBuddy -c "Set :LSEnvironment:TERMLOOP_REPO_ROOT \"${PWD}\"" "$INFO_PLIST" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :LSEnvironment:TERMLOOP_REPO_ROOT string \"${PWD}\"" "$INFO_PLIST"
      if [[ -S "$TERMLOOPD_SOCKET" ]]; then
        for PID in $(lsof -t "$TERMLOOPD_SOCKET" 2>/dev/null); do
          kill "$PID" 2>/dev/null || true
        done
        rm -f "$TERMLOOPD_SOCKET"
      fi
      if [[ -S "$TERMLOOP_SOCKET" ]]; then
        rm -f "$TERMLOOP_SOCKET"
      fi
    fi
    /usr/bin/codesign --force --sign - --timestamp=none --generate-entitlement-der "$TAG_APP_PATH" >/dev/null 2>&1 || true
  fi
  APP_PATH="$TAG_APP_PATH"
fi

CLI_PATH="$(dirname "$APP_PATH")/termloop"
if [[ -x "$CLI_PATH" ]]; then
  (umask 077; printf '%s\n' "$CLI_PATH" > /tmp/termloop-last-cli-path) || true
  ln -sfn "$CLI_PATH" /tmp/termloop-cli || true

  # Stable shim that always follows the last reload-selected dev CLI.
  DEV_CLI_SHIM="$HOME/.local/bin/termloop-dev"
  write_dev_cli_shim "$DEV_CLI_SHIM" "/Applications/TermLoop.app/Contents/Resources/bin/termloop"

  TERMLOOP_SHIM_TARGET="$(select_termloop_shim_target || true)"
  if [[ -n "${TERMLOOP_SHIM_TARGET:-}" ]]; then
    write_dev_cli_shim "$TERMLOOP_SHIM_TARGET" "/Applications/TermLoop.app/Contents/Resources/bin/termloop"
  fi
fi

# Build termloopd and ghostty helper binaries (needed for both launch and no-launch).
TERMLOOPD_SRC="$PWD/cmuxd/zig-out/bin/termloopd"
GHOSTTY_HELPER_SRC="$PWD/ghostty/zig-out/bin/ghostty"
if [[ -d "$PWD/cmuxd" ]]; then
  (cd "$PWD/cmuxd" && zig build -Doptimize=ReleaseFast)
fi
if [[ -d "$PWD/ghostty" ]]; then
  if [[ "${TERMLOOP_SKIP_ZIG_BUILD:-}" == "1" ]]; then
    echo "Skipping direct ghostty CLI helper zig build (TERMLOOP_SKIP_ZIG_BUILD=1)"
  else
    (cd "$PWD/ghostty" && zig build cli-helper -Dapp-runtime=none -Demit-macos-app=false -Demit-xcframework=false -Doptimize=ReleaseFast)
  fi
fi
if [[ -x "$TERMLOOPD_SRC" ]]; then
  BIN_DIR="$APP_PATH/Contents/Resources/bin"
  mkdir -p "$BIN_DIR"
  cp "$TERMLOOPD_SRC" "$BIN_DIR/termloopd"
  chmod +x "$BIN_DIR/termloopd"
fi
if [[ -x "$GHOSTTY_HELPER_SRC" ]]; then
  BIN_DIR="$APP_PATH/Contents/Resources/bin"
  mkdir -p "$BIN_DIR"
  cp "$GHOSTTY_HELPER_SRC" "$BIN_DIR/ghostty"
  chmod +x "$BIN_DIR/ghostty"
fi
CLI_PATH="$APP_PATH/Contents/Resources/bin/termloop"
if [[ -x "$CLI_PATH" ]]; then
  echo "$CLI_PATH" > /tmp/termloop-last-cli-path || true
fi

if [[ "$LAUNCH" -eq 1 ]]; then
  # Ensure any running instance is fully terminated, regardless of DerivedData path.
  /usr/bin/osascript -e "tell application id \"${BUNDLE_ID}\" to quit" >/dev/null 2>&1 || true
  sleep 0.3
  if [[ -z "$TAG" ]]; then
    # Non-tag mode: kill any running instance (across any DerivedData path) to avoid socket conflicts.
    pkill -f "/${BASE_APP_NAME}.app/Contents/MacOS/${BASE_APP_NAME}" || true
  else
    # Tag mode: only kill the tagged instance; allow side-by-side with the main app.
    pkill -f "${APP_NAME}.app/Contents/MacOS/${BASE_APP_NAME}" || true
  fi
  sleep 0.3

  # Avoid inheriting TermLoop/Ghostty environment variables from the terminal that
  # runs this script (often inside another termloop instance), which can cause
  # socket and resource-path conflicts.
  OPEN_CLEAN_ENV=(
    env
    -u TERMLOOP_SOCKET_PATH
    -u TERMLOOP_WORKSPACE_ID
    -u TERMLOOP_SURFACE_ID
    -u TERMLOOP_TAB_ID
    -u TERMLOOP_PANEL_ID
    -u TERMLOOPD_UNIX_PATH
    -u TERMLOOP_TAG
    -u TERMLOOP_DEBUG_LOG
    -u TERMLOOP_BUNDLE_ID
    -u TERMLOOP_SHELL_INTEGRATION
    -u GHOSTTY_BIN_DIR
    -u GHOSTTY_RESOURCES_DIR
    -u GHOSTTY_SHELL_FEATURES
    # Dev shells (including CI/Codex) often force-disable paging by exporting these.
    # Don't leak that into TermLoop, otherwise `git diff` won't page even with PAGER=less.
    -u GIT_PAGER
    -u GH_PAGER
    -u TERMINFO
    -u XDG_DATA_DIRS
  )

  if [[ -n "${TAG_SLUG:-}" && -n "${TERMLOOP_SOCKET:-}" ]]; then
    # Ensure tag-specific socket paths win even if the caller has TermLoop socket overrides.
    "${OPEN_CLEAN_ENV[@]}" TERMLOOP_TAG="$TAG_SLUG" TERMLOOP_SOCKET_ENABLE=1 TERMLOOP_SOCKET_MODE=allowAll TERMLOOP_SOCKET_PATH="$TERMLOOP_SOCKET" TERMLOOPD_UNIX_PATH="$TERMLOOPD_SOCKET" TERMLOOP_DEBUG_LOG="$TERMLOOP_DEBUG_LOG" TERMLOOP_REMOTE_DAEMON_ALLOW_LOCAL_BUILD=1 TERMLOOP_REPO_ROOT="$PWD" open -g "$APP_PATH"
  elif [[ -n "${TAG_SLUG:-}" ]]; then
    "${OPEN_CLEAN_ENV[@]}" TERMLOOP_TAG="$TAG_SLUG" TERMLOOP_SOCKET_ENABLE=1 TERMLOOP_SOCKET_MODE=allowAll TERMLOOP_DEBUG_LOG="$TERMLOOP_DEBUG_LOG" TERMLOOP_REMOTE_DAEMON_ALLOW_LOCAL_BUILD=1 TERMLOOP_REPO_ROOT="$PWD" open -g "$APP_PATH"
  else
    echo "/tmp/termloop-debug.sock" > /tmp/termloop-last-socket-path || true
    echo "/tmp/termloop-debug.log" > /tmp/termloop-last-debug-log-path || true
    "${OPEN_CLEAN_ENV[@]}" open -g "$APP_PATH"
  fi

  # Safety: ensure only one instance is running.
  sleep 0.2
  PIDS=($(pgrep -f "${APP_PATH}/Contents/MacOS/" || true))
  if [[ "${#PIDS[@]}" -gt 1 ]]; then
    NEWEST_PID=""
    NEWEST_AGE=999999
    for PID in "${PIDS[@]}"; do
      AGE="$(ps -o etimes= -p "$PID" | tr -d ' ')"
      if [[ -n "$AGE" && "$AGE" -lt "$NEWEST_AGE" ]]; then
        NEWEST_AGE="$AGE"
        NEWEST_PID="$PID"
      fi
    done
    for PID in "${PIDS[@]}"; do
      if [[ "$PID" != "$NEWEST_PID" ]]; then
        kill "$PID" 2>/dev/null || true
      fi
    done
  fi
fi

echo
echo "App path:"
echo "  $APP_PATH"

if [[ -n "${TAG_SLUG:-}" ]]; then
  print_tag_cleanup_reminder "$TAG_SLUG"
fi

if [[ -x "${CLI_PATH:-}" ]]; then
  echo
  echo "CLI path:"
  echo "  $CLI_PATH"
  echo "CLI helpers:"
  echo "  /tmp/termloop-cli ..."
  echo "  $HOME/.local/bin/termloop-dev ..."
  if [[ -n "${TERMLOOP_SHIM_TARGET:-}" ]]; then
    echo "  $TERMLOOP_SHIM_TARGET ..."
  fi
  echo "If your shell still resolves the old termloop binary, run: rehash"
fi

if [[ "$LAUNCH" -eq 0 ]]; then
  echo
  echo "Build complete. Pass --launch to open the app, or cmd-click the path above."
fi
