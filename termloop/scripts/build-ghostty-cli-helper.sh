#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/build-ghostty-cli-helper.sh [--universal | --target <zig-target>] --output <path>

Options:
  --universal      Build a universal macOS helper (arm64 + x86_64).
  --target <triple>
                   Build a single target, e.g. `aarch64-macos` or `x86_64-macos`.
  --output <path>  Destination path for the built helper.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GHOSTTY_DIR="$REPO_ROOT/ghostty"

OUTPUT_PATH=""
TARGET_TRIPLE=""
UNIVERSAL="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --universal)
      UNIVERSAL="true"
      shift
      ;;
    --target)
      TARGET_TRIPLE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$OUTPUT_PATH" ]]; then
  echo "Missing required --output path" >&2
  usage >&2
  exit 1
fi

if [[ "$UNIVERSAL" == "true" && -n "$TARGET_TRIPLE" ]]; then
  echo "--universal and --target are mutually exclusive" >&2
  usage >&2
  exit 1
fi

if [[ -n "$TARGET_TRIPLE" ]]; then
  case "$TARGET_TRIPLE" in
    aarch64-macos|x86_64-macos)
      ;;
    *)
      echo "Unsupported --target value: $TARGET_TRIPLE" >&2
      exit 1
      ;;
  esac

  # When the requested target matches zig's native output arch, drop -Dtarget
  # so zig uses native compilation. This avoids cross-linker issues on newer
  # SDKs (e.g., macOS Tahoe + zig 0.15.x). Note: zig may run under Rosetta,
  # so we detect native output arch from the zig binary itself, not uname -m.
  ZIG_ARCH="$(file "$(command -v zig)" 2>/dev/null | grep -oE '(arm64|x86_64)' | head -1)"
  case "$TARGET_TRIPLE" in
    aarch64-macos) [[ "$ZIG_ARCH" == "arm64" ]] && TARGET_TRIPLE="" ;;
    x86_64-macos)  [[ "$ZIG_ARCH" == "x86_64" ]] && TARGET_TRIPLE="" ;;
  esac
fi

emit_stub_binary() {
  local output_path="$1"
  local target="${2:-}"
  local stub_dir
  stub_dir="$(mktemp -d "${TMPDIR:-/tmp}/cmux-ghostty-stub.XXXXXX")"

  cat > "$stub_dir/main.c" <<'EOF'
#include <stdio.h>

int main(void) {
  fputs("ghostty CLI helper stub (zig build skipped)\n", stderr);
  return 1;
}
EOF

  build_stub_arch() {
    local arch="$1"
    local out="$2"
    xcrun clang -arch "$arch" -Os "$stub_dir/main.c" -o "$out"
  }

  mkdir -p "$(dirname "$output_path")"

  if [[ "$UNIVERSAL" == "true" ]]; then
    build_stub_arch arm64 "$stub_dir/ghostty-arm64"
    build_stub_arch x86_64 "$stub_dir/ghostty-x86_64"
    /usr/bin/lipo -create \
      "$stub_dir/ghostty-arm64" \
      "$stub_dir/ghostty-x86_64" \
      -output "$output_path"
  else
    local stub_arch
    case "$target" in
      aarch64-macos) stub_arch="arm64" ;;
      x86_64-macos) stub_arch="x86_64" ;;
      "") stub_arch="$(uname -m)" ;;
      *)
        echo "Unsupported stub target: $target" >&2
        rm -rf "$stub_dir"
        exit 1
        ;;
    esac
    build_stub_arch "$stub_arch" "$output_path"
  fi

  chmod +x "$output_path"
  rm -rf "$stub_dir"
}

if [[ "${TERMLOOP_SKIP_ZIG_BUILD:-}" == "1" ]]; then
  echo "Skipping zig CLI helper build (TERMLOOP_SKIP_ZIG_BUILD=1)"
  emit_stub_binary "$OUTPUT_PATH" "$TARGET_TRIPLE"
  exit 0
fi

if ! command -v zig >/dev/null 2>&1; then
  echo "error: zig is required to build the Ghostty CLI helper" >&2
  exit 1
fi

if [[ ! -f "$GHOSTTY_DIR/build.zig" ]]; then
  echo "error: vendored Ghostty source is missing at $GHOSTTY_DIR" >&2
  exit 1
fi

build_helper() {
  local prefix="$1"
  local target="${2:-}"
  local args=(
    zig build
    cli-helper
    -Dapp-runtime=none
    -Demit-macos-app=false
    -Demit-xcframework=false
    -Doptimize=ReleaseFast
    --prefix
    "$prefix"
  )

  if [[ -n "$target" ]]; then
    args+=("-Dtarget=$target")
  fi

  (
    cd "$GHOSTTY_DIR"
    "${args[@]}"
  )
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cmux-ghostty-helper.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$(dirname "$OUTPUT_PATH")"

if [[ "$UNIVERSAL" == "true" ]]; then
  ARM64_PREFIX="$TMP_DIR/arm64"
  X86_PREFIX="$TMP_DIR/x86_64"
  ZIG_ARCH="$(file "$(command -v zig)" 2>/dev/null | grep -oE '(arm64|x86_64)' | head -1)"
  # Use native compilation for the matching arch to avoid cross-linker issues
  if [[ "$ZIG_ARCH" == "arm64" ]]; then
    build_helper "$ARM64_PREFIX" ""
    build_helper "$X86_PREFIX" "x86_64-macos"
  elif [[ "$ZIG_ARCH" == "x86_64" ]]; then
    build_helper "$ARM64_PREFIX" "aarch64-macos"
    build_helper "$X86_PREFIX" ""
  else
    build_helper "$ARM64_PREFIX" "aarch64-macos"
    build_helper "$X86_PREFIX" "x86_64-macos"
  fi
  /usr/bin/lipo -create \
    "$ARM64_PREFIX/bin/ghostty" \
    "$X86_PREFIX/bin/ghostty" \
    -output "$OUTPUT_PATH"
else
  SINGLE_PREFIX="$TMP_DIR/single"
  build_helper "$SINGLE_PREFIX" "$TARGET_TRIPLE"
  install -m 755 "$SINGLE_PREFIX/bin/ghostty" "$OUTPUT_PATH"
fi

chmod +x "$OUTPUT_PATH"
