#!/usr/bin/env bash
# Shared bash helpers for TermLoop wrapper scripts (bin/claude, bin/codex,
# future agents). Owns the TermLoop live-context fetch + injection plumbing.
# Agent-specific concerns (session-id, NODE_OPTIONS, settings merge, etc.)
# stay in each wrapper.
#
# Source from a wrapper:
#
#   source "$(dirname "$0")/lib/termloop-context.sh"
#   if ! termloop_context_should_skip; then
#       prompt="$(termloop_context_fetch <agent_id>)"
#       ... agent-specific delivery ...
#   fi
#
# Fail-open: any failure inside these helpers should leave the wrapper
# behaving as if TermLoop weren't installed. Never block the agent.

termloop_context_resolve_cli() {
    local bundled="${TERMLOOP_BUNDLED_CLI_PATH:-}"
    if [[ -n "$bundled" && -x "$bundled" ]]; then
        printf '%s' "$bundled"
        return 0
    fi
    local self_dir
    self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    bundled="$self_dir/termloop"
    if [[ -x "$bundled" ]]; then
        printf '%s' "$bundled"
        return 0
    fi
    bundled="$(command -v termloop 2>/dev/null || true)"
    if [[ -n "$bundled" ]]; then
        printf '%s' "$bundled"
        return 0
    fi
    return 1
}

termloop_context_socket_alive() {
    local cli="${1:-}"
    [[ -n "$cli" && -x "$cli" ]] || return 1
    local socket="${TERMLOOP_SOCKET:-${CMUX_SOCKET:-}}"
    [[ -n "$socket" && -S "$socket" ]] || return 1
    TERMLOOP_CLI_RESPONSE_TIMEOUT_SEC=0.75 \
        "$cli" --socket "$socket" ping >/dev/null 2>&1
}

# Returns 0 (true) if the wrapper should SKIP context injection.
# Reasons: not in an TermLoop terminal, hooks disabled, no socket, or
# the runner already provided the context inline (env signal).
# Caller can layer additional skips (housekeeping subcommands, user override).
termloop_context_should_skip() {
    [[ -n "${TERMLOOP_WORKSPACE_ID:-}" ]] || return 0
    [[ "${TERMLOOP_HOOKS_DISABLED:-}" != "1" ]] || return 0
    # Runner-launched terminals: TermLoop already wrote the full
    # workspace context into the agent CLI's per-invocation flag, so
    # re-fetching here would either duplicate (codex wrapper merges)
    # or be ignored (claude wrapper SKIP_AUTO_APPEND already triggers).
    # Shell-launched terminals don't have this env, so they keep the
    # fetch path.
    [[ "${TERMLOOP_LAUNCH_PROVIDED_CONTEXT:-}" != "1" ]] || return 0
    local cli
    cli="$(termloop_context_resolve_cli)" || return 0
    termloop_context_socket_alive "$cli" || return 0
    return 1
}

# Fetch the joined system-prompt block (abilities + reported context) for
# the given agent in the current workspace/cwd. Echoes empty on failure.
termloop_context_fetch() {
    local agent_id="${1:-}"
    [[ -n "$agent_id" ]] || return 0
    local cli
    cli="$(termloop_context_resolve_cli)" || return 0
    # CLI default socket discovery doesn't honor TERMLOOP_SOCKET env —
    # always pass the tag-specific socket explicitly so the wrapper hits the
    # same instance it was launched from (not the user's main/production).
    local socket="${TERMLOOP_SOCKET:-${CMUX_SOCKET:-}}"
    local -a socket_args=()
    [[ -n "$socket" ]] && socket_args=(--socket "$socket")
    # Backwards-compat: the legacy `claude-system-prompt` CLI verb hits the
    # legacy `workspace.claude_system_prompt` socket method and exists on
    # every TermLoop build that has ever shipped Claude support. The new
    # `agent-system-prompt` verb only exists on builds that include this
    # change. Route Claude through the legacy path so a wrapper from a new
    # bundle still works against an older running instance (e.g. the user's
    # production app socket); other agents need the new verb regardless.
    if [[ "$agent_id" == "claude" ]]; then
        "$cli" "${socket_args[@]}" claude-system-prompt \
            --workspace "$TERMLOOP_WORKSPACE_ID" \
            --cwd "$PWD" 2>/dev/null || true
    else
        "$cli" "${socket_args[@]}" agent-system-prompt \
            --agent "$agent_id" \
            --workspace "$TERMLOOP_WORKSPACE_ID" \
            --cwd "$PWD" 2>/dev/null || true
    fi
}

# Write content to a tempfile, echo the path. Caller owns cleanup if needed
# (the runner already cleans up its own per-launch tempfile dir).
termloop_context_write_tempfile() {
    local content="$1"
    local dir
    dir="${TMPDIR:-/tmp}/termloop-system-prompts"
    mkdir -p "$dir" 2>/dev/null || dir="${TMPDIR:-/tmp}"
    local file
    # macOS BSD mktemp only substitutes X's when they're at the end of the
    # template — `wrapper-XXXXXXXX.md` is taken literally and collides on
    # repeat invocations. Suffix-free template fixes it; Codex doesn't care
    # about file extension.
    file="$(mktemp "$dir/wrapper-XXXXXXXX" 2>/dev/null || true)"
    [[ -n "$file" ]] || return 1
    printf '%s' "$content" > "$file" 2>/dev/null || return 1
    printf '%s' "$file"
}
