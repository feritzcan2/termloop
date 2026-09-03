#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title TermLoop Remove Builds
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🧹
# @raycast.packageName TermLoop
# @raycast.needsConfirmation false
# @raycast.argument1 { "type": "text", "placeholder": "blank = clean, dry = preview, all = also release output", "optional": true }

# Documentation:
# @raycast.description Delete TermLoop build artifacts EXCEPT the main checkout's current build. Keeps target/debug's live output so the main app never needs a full rebuild, but prunes superseded incremental compiler caches and boots out dead per-profile launchd registrations. Skips anything currently running.
# @raycast.author feritzcan

set -euo pipefail

# Raycast strips most of the user shell PATH; restore Homebrew + cargo + Xcode tools.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CHECKOUT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# Keep the existing support root so installed builds retain their profiles and state.
SUPPORT="$HOME/Library/Application Support/termloop-next"
PROFILES_DIR="$SUPPORT/profiles"
LAUNCHES_DIR="$SUPPORT/launches"
LAUNCHER="$CHECKOUT/tools/dev/termloop-dev"

# An agent session that touched its cargo target this recently is probably still
# building; leave its cache alone.
AGENT_SESSION_KEEP_MINUTES=120

# rustc keys an incremental cache directory by compilation inputs, so every
# meaningful dependency change gives a workspace crate a brand-new
# incremental/<crate>-<hash> directory and orphans the previous one forever.
# Cargo never collects those, and age is not the signal: a crate compiled once
# with today's inputs is current no matter how old the rest of the pile is.
# Keep the newest few per crate name and drop what has been superseded.
#
# Dropping a superseded cache costs nothing now: cargo freshness comes from
# .fingerprint and deps/, not from this directory. The only cost is that the
# next rebuild of that exact crate under those exact inputs starts cold.
INCREMENTAL_KEEP_PER_CRATE=2

MODE="${1:-clean}"
case "$MODE" in
  "" | clean) MODE="clean" ;;
  dry | all) ;;
  *)
    echo "Unknown mode: $MODE (use blank, 'dry', or 'all')" >&2
    exit 2
    ;;
esac

if [ ! -d "$CHECKOUT" ]; then
  echo "TermLoop checkout not found: $CHECKOUT" >&2
  exit 1
fi

freed_kb=0
dropped_count=0
kept_notes=()
failed_notes=()

# Print "none" when a section ended up removing nothing, so an empty heading is
# never mistaken for a silent failure.
section_start=0
begin_section() {
  echo "$1:"
  section_start="$dropped_count"
}
end_section() {
  [ "$dropped_count" -eq "$section_start" ] && echo "  nothing to remove"
  echo
}

human() {
  local kb="$1"
  if [ "$kb" -ge 1048576 ]; then
    printf '%.1f GB' "$(echo "$kb" | awk '{print $1/1048576}')"
  else
    printf '%d MB' "$((kb / 1024))"
  fi
}

# True when any running process names this path, which is how a build that
# started after the liveness check above still gets protected.
path_is_busy() {
  pgrep -f "$1" >/dev/null 2>&1
}

# Delete one path, accounting for the space it held. Never follows symlinks and
# never accepts an empty or root-ish argument.
#
# Removal is a rename first, then a delete of the renamed copy. A writer that
# starts mid-delete would otherwise keep recreating files under the original
# path, which makes `rm -rf` fail with "Directory not empty" and leaves a
# half-deleted build behind. The rename takes the tree out of the writer's way
# in one step.
drop() {
  local path="$1"
  local label="$2"
  # Pass "quiet" to account for the removal without printing its own line; the
  # caller then reports one aggregated line for the whole group.
  local quiet="${3:-}"
  local kb trash

  case "$path" in
    "" | "/" | "$HOME" | "$HOME/") echo "  refusing unsafe path: '$path'" >&2; return 0 ;;
  esac
  [ -e "$path" ] || return 0
  [ -L "$path" ] && { echo "  skip symlink: $path"; return 0; }

  kb="$(du -sk "$path" 2>/dev/null | awk '{print $1}')"
  kb="${kb:-0}"

  if path_is_busy "$path"; then
    kept_notes+=("$label — a running process is writing to it")
    return 0
  fi

  if [ "$MODE" = "dry" ]; then
    [ "$quiet" = "quiet" ] || printf '  would remove %-9s %s\n' "$(human "$kb")" "$label"
    freed_kb=$((freed_kb + kb))
    dropped_count=$((dropped_count + 1))
    return 0
  fi

  trash="$(dirname "$path")/.termloop-cleanup.$$"
  mkdir -p "$trash" 2>/dev/null || true
  if [ -d "$trash" ] && mv "$path" "$trash/" 2>/dev/null; then
    rm -rf "$trash" 2>/dev/null || true
  else
    rm -rf "$path" 2>/dev/null || true
  fi
  rm -rf "$trash" 2>/dev/null || true

  if [ -e "$path" ]; then
    failed_notes+=("$label — still present after removal, likely in use")
    return 0
  fi

  [ "$quiet" = "quiet" ] || printf '  removed %-9s %s\n' "$(human "$kb")" "$label"
  freed_kb=$((freed_kb + kb))
  dropped_count=$((dropped_count + 1))
}

# One aggregated "removed 1.2 GB label (37 directories)" line for a group that
# was dropped quietly. Prints nothing when the group removed nothing.
report_group() {
  local label="$1"
  local kb_before="$2"
  local count_before="$3"
  local removed=$((dropped_count - count_before))

  [ "$removed" -gt 0 ] || return 0
  if [ "$MODE" = "dry" ]; then
    printf '  would remove %-9s %s (%d directories)\n' \
      "$(human $((freed_kb - kb_before)))" "$label" "$removed"
  else
    printf '  removed %-9s %s (%d directories)\n' \
      "$(human $((freed_kb - kb_before)))" "$label" "$removed"
  fi
}

# True while cargo or rustc is working in the main checkout's shared build
# directory. Incremental caches are only safe to prune when nothing is writing
# them, and the cargo build lock is the exact authority on that.
main_build_in_progress() {
  local lock="$CHECKOUT/target/debug/.cargo-lock"

  if [ -e "$lock" ] && lsof -t "$lock" >/dev/null 2>&1; then
    return 0
  fi
  pgrep -f "incremental=$CHECKOUT/target/debug/incremental" >/dev/null 2>&1
}

echo "TermLoop build cleanup (mode: $MODE)"
echo "Protected: the main checkout's current build output in $CHECKOUT/target/debug"
echo "Pruned there: only incremental caches already superseded by a newer one"
echo

# ---------------------------------------------------------------------------
# What is currently alive, so nothing in use gets removed.
# ---------------------------------------------------------------------------
running_profiles=""
running_checkouts=""
if [ -x "$LAUNCHER" ]; then
  running_profiles="$("$LAUNCHER" list 2>/dev/null | awk -F'|' 'NR>1 && $2=="running" {print $1}')"
  running_checkouts="$("$LAUNCHER" list 2>/dev/null | awk -F'|' 'NR>1 && $2=="running" {print $3}')"
fi
live_bundles="$(ps auxww 2>/dev/null | grep -oE 'bundle\.[A-Za-z0-9]+' | sort -u || true)"

is_listed() {
  local needle="$1"
  local haystack="$2"
  [ -n "$needle" ] || return 1
  printf '%s\n' "$haystack" | grep -qxF "$needle"
}

# ---------------------------------------------------------------------------
# 1. Cargo build output that agents write, set by modules/invocation. Current
#    launches share target/agents; target/agent-sessions/<sha256> is the older
#    per-Session layout and only leftovers remain there. Neither is the main
#    checkout's own build.
# ---------------------------------------------------------------------------
begin_section "Agent cargo build output"
if [ -d "$CHECKOUT/target/agents" ]; then
  if [ -n "$(find "$CHECKOUT/target/agents" -maxdepth 0 -mmin "-$AGENT_SESSION_KEEP_MINUTES" 2>/dev/null)" ]; then
    kept_notes+=("target/agents touched in the last ${AGENT_SESSION_KEEP_MINUTES}m")
  else
    drop "$CHECKOUT/target/agents" "target/agents (shared agent build cache)"
  fi
fi

# Dev launcher profiles share target/dev-profiles since termloop-dev stopped
# giving every --tag its own cargo-target. Regenerable, and never the main
# checkout's own build.
if [ -d "$CHECKOUT/target/dev-profiles" ]; then
  if [ -n "$(find "$CHECKOUT/target/dev-profiles" -maxdepth 0 -mmin "-$AGENT_SESSION_KEEP_MINUTES" 2>/dev/null)" ]; then
    kept_notes+=("target/dev-profiles touched in the last ${AGENT_SESSION_KEEP_MINUTES}m")
  else
    drop "$CHECKOUT/target/dev-profiles" "target/dev-profiles (shared dev profile build cache)"
  fi
fi

agent_sessions_dir="$CHECKOUT/target/agent-sessions"
if [ -d "$agent_sessions_dir" ]; then
  for dir in "$agent_sessions_dir"/*; do
    [ -d "$dir" ] || continue
    if [ -n "$(find "$dir" -maxdepth 0 -mmin "-$AGENT_SESSION_KEEP_MINUTES" 2>/dev/null)" ]; then
      kept_notes+=("agent session $(basename "$dir" | cut -c1-12)… touched in the last ${AGENT_SESSION_KEEP_MINUTES}m")
      continue
    fi
    drop "$dir" "agent-sessions/$(basename "$dir" | cut -c1-12)… (legacy per-Session cache)"
  done
  rmdir "$agent_sessions_dir" 2>/dev/null || true
fi
end_section

# ---------------------------------------------------------------------------
# 2. Superseded incremental compiler caches in the main checkout. This is the
#    only thing inside the protected target/debug that is removed, and only
#    when a newer cache of the same crate has already replaced it. The newest
#    INCREMENTAL_KEEP_PER_CRATE per crate name stay, so the main app keeps a
#    warm rebuild path for whatever it is actually compiling now.
# ---------------------------------------------------------------------------
incremental_dir="$CHECKOUT/target/debug/incremental"
begin_section "Superseded incremental compiler caches (main checkout)"
if [ ! -d "$incremental_dir" ]; then
  :
elif main_build_in_progress; then
  kept_notes+=("incremental caches — cargo is building in the main checkout")
else
  # One stat pass, newest first, so every crate's own slice is already ordered.
  incremental_index="$(
    find "$incremental_dir" -mindepth 1 -maxdepth 1 -type d \
      -exec stat -f '%m %N' {} + 2>/dev/null | sort -rn || true
  )"
  crate_names="$(
    printf '%s\n' "$incremental_index" | sed 's|.*/||' | sed -E 's/-[^-]+$//' |
      sort -u
  )"
  while IFS= read -r crate; do
    [ -n "$crate" ] || continue
    crate_kb_before="$freed_kb"
    crate_count_before="$dropped_count"
    rank=0
    while IFS= read -r session; do
      [ -n "$session" ] || continue
      rank=$((rank + 1))
      [ "$rank" -le "$INCREMENTAL_KEEP_PER_CRATE" ] && continue
      # A cache this fresh belongs to a build that started after the lock check
      # above, so leave it even though a newer sibling exists.
      if [ -n "$(find "$session" -maxdepth 0 -mmin "-$AGENT_SESSION_KEEP_MINUTES" 2>/dev/null)" ]; then
        kept_notes+=("incremental cache $(basename "$session") touched in the last ${AGENT_SESSION_KEEP_MINUTES}m")
        continue
      fi
      drop "$session" "incremental/$(basename "$session")" quiet
    done < <(
      printf '%s\n' "$incremental_index" |
        awk -v prefix="$crate-" '
          {
            path = substr($0, index($0, " ") + 1)
            n = split(path, parts, "/")
            name = parts[n]
            if (index(name, prefix) == 1 &&
                index(substr(name, length(prefix) + 1), "-") == 0) {
              print path
            }
          }
        '
    )
    report_group "incremental/$crate" "$crate_kb_before" "$crate_count_before"
  done <<< "$crate_names"
fi
end_section

# ---------------------------------------------------------------------------
# 3. Tagged dev profiles. Each holds its own cargo-target, Electron profile and
#    launch bundles. The main profile does NOT live here (it is $SUPPORT itself).
# ---------------------------------------------------------------------------
begin_section "Tagged dev profiles"
if [ -d "$PROFILES_DIR" ]; then
  for dir in "$PROFILES_DIR"/*; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    if is_listed "$name" "$running_profiles"; then
      kept_notes+=("profile $name is running")
      continue
    fi
    drop "$dir" "profile $name"
  done
fi
end_section

# ---------------------------------------------------------------------------
# 4. Per-profile launchd registrations of profiles that are gone. termloop-dev
#    bootstraps one LaunchAgent per profile from its own support directory and
#    only boots it out through stop/stop-profile, so a profile that died, or
#    whose directory was just removed above, stays loaded in launchd forever as
#    an exited job. That costs no disk, but it keeps every retired feature tag
#    visible to launchd and to the macOS background-item UI.
#
#    Only jobs launchd reports with no PID are considered, the human-owned main
#    profile is never touched, and a profile with a running supervisor is kept.
# ---------------------------------------------------------------------------
unloaded_count=0
echo "Stale launchd registrations:"
if [ "$(uname -s)" = "Darwin" ]; then
  gui_domain="gui/$(id -u)"
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    profile_name="${label#com.termloop.next.dev.}"
    if [ "$profile_name" = "main" ]; then
      kept_notes+=("launchd job $label is the human-owned main profile")
      continue
    fi
    if is_listed "$profile_name" "$running_profiles"; then
      kept_notes+=("launchd job $label has a running profile")
      continue
    fi
    if [ "$MODE" = "dry" ]; then
      printf '  would unload %s\n' "$label"
      unloaded_count=$((unloaded_count + 1))
      continue
    fi
    launchctl bootout "$gui_domain/$label" >/dev/null 2>&1 || true
    if launchctl print "$gui_domain/$label" >/dev/null 2>&1; then
      failed_notes+=("launchd job $label — still loaded after bootout")
      continue
    fi
    printf '  unloaded %s\n' "$label"
    unloaded_count=$((unloaded_count + 1))
  done < <(
    launchctl list 2>/dev/null |
      awk '$1 == "-" && $3 ~ /^com\.termloop\.next\.dev\./ { print $3 }'
  )
else
  echo "  not macOS: skipped"
fi
[ "$unloaded_count" -eq 0 ] && echo "  nothing to remove"
echo

# ---------------------------------------------------------------------------
# 5. Stale launch bundles of the main profile. These are staged copies of an
#    already-built binary, never the build itself, so removing an unreferenced
#    one costs nothing.
# ---------------------------------------------------------------------------
begin_section "Stale launch bundles"
active_bundle=""
if [ -f "$SUPPORT/dev-launch-bundle.path" ]; then
  active_bundle="$(sed -n '1p' "$SUPPORT/dev-launch-bundle.path")"
fi
if [ -d "$LAUNCHES_DIR" ]; then
  for dir in "$LAUNCHES_DIR"/*; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    if is_listed "$name" "$live_bundles"; then
      kept_notes+=("launch bundle $name is in use")
      continue
    fi
    if [ -n "$active_bundle" ] && [ "$dir" = "$active_bundle" ]; then
      kept_notes+=("launch bundle $name is the recorded active bundle")
      continue
    fi
    drop "$dir" "launches/$name"
  done
fi
end_section

# ---------------------------------------------------------------------------
# 6. Build output inside other checkouts of this repository (worktrees).
#    The main checkout is skipped by name, so its target/ is never touched.
# ---------------------------------------------------------------------------
begin_section "Worktree build output"
while IFS= read -r worktree; do
  [ -n "$worktree" ] || continue
  [ "$worktree" = "$CHECKOUT" ] && continue
  [ -d "$worktree" ] || continue
  if is_listed "$worktree" "$running_checkouts"; then
    kept_notes+=("worktree $(basename "$worktree") has a running profile")
    continue
  fi
  for artifact in target clients/desktop/dist clients/desktop/out; do
    if [ -d "$worktree/$artifact" ]; then
      drop "$worktree/$artifact" "$(basename "$worktree")/$artifact"
    fi
  done
done < <(git -C "$CHECKOUT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
end_section

# ---------------------------------------------------------------------------
# 7. Release packaging output in the main checkout. Regenerated by
#    `pnpm package`; the dev flow uses clients/desktop/dist instead. Opt-in,
#    since it is the only step that reaches into the main checkout.
# ---------------------------------------------------------------------------
if [ "$MODE" = "all" ]; then
  echo "Release packaging output (main checkout):"
  drop "$CHECKOUT/clients/desktop/out" "clients/desktop/out"
  echo
else
  if [ -d "$CHECKOUT/clients/desktop/out" ]; then
    echo "Release packaging output (main checkout): kept — rerun with 'all' to remove it"
    echo
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [ "${#kept_notes[@]}" -gt 0 ]; then
  echo "Kept because still in use:"
  for note in "${kept_notes[@]}"; do
    echo "  - $note"
  done
  echo
fi

if [ "${#failed_notes[@]}" -gt 0 ]; then
  echo "Could not remove:"
  for note in "${failed_notes[@]}"; do
    echo "  - $note"
  done
  echo "  Rerun once the build or app using them has finished."
  echo
fi

if [ "$MODE" = "dry" ]; then
  echo "Would free: $(human "$freed_kb")  (nothing was deleted)"
else
  echo "Freed: $(human "$freed_kb")"
fi
if [ "$unloaded_count" -gt 0 ]; then
  if [ "$MODE" = "dry" ]; then
    echo "Would unload: $unloaded_count launchd registration(s)"
  else
    echo "Unloaded: $unloaded_count launchd registration(s)"
  fi
fi
echo "Disk now: $(df -h /System/Volumes/Data | tail -1 | awk '{print $4 " free of " $2}')"
