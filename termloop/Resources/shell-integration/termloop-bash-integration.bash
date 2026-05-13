# termloop shell integration for bash

# Cache which send tool is available to avoid repeated PATH lookups.
_TERMLOOP_SEND_TOOL=""
_termloop_detect_send_tool() {
    if command -v ncat >/dev/null 2>&1; then
        _TERMLOOP_SEND_TOOL=ncat
    elif command -v socat >/dev/null 2>&1; then
        _TERMLOOP_SEND_TOOL=socat
    elif command -v nc >/dev/null 2>&1; then
        _TERMLOOP_SEND_TOOL=nc
    fi
}
# Detection deferred to after _termloop_fix_path (end of file).

_termloop_send() {
    local payload="$1"
    case "$_TERMLOOP_SEND_TOOL" in
        ncat)
            printf '%s\n' "$payload" | ncat -w 1 -U "$TERMLOOP_SOCKET_PATH" --send-only
            ;;
        socat)
            printf '%s\n' "$payload" | socat -T 1 - "UNIX-CONNECT:$TERMLOOP_SOCKET_PATH" >/dev/null 2>&1
            ;;
        nc)
            if printf '%s\n' "$payload" | nc -N -U "$TERMLOOP_SOCKET_PATH" >/dev/null 2>&1; then
                :
            else
                printf '%s\n' "$payload" | nc -w 1 -U "$TERMLOOP_SOCKET_PATH" >/dev/null 2>&1 || true
            fi
            ;;
    esac
}

_termloop_socket_is_unix() {
    [[ -n "$TERMLOOP_SOCKET_PATH" && -S "$TERMLOOP_SOCKET_PATH" ]]
}

_termloop_relay_cli_path() {
    if [[ -n "${TERMLOOP_BUNDLED_CLI_PATH:-}" && -x "${TERMLOOP_BUNDLED_CLI_PATH}" ]]; then
        printf '%s\n' "${TERMLOOP_BUNDLED_CLI_PATH}"
        return 0
    fi
    command -v termloop 2>/dev/null
}

_termloop_socket_uses_remote_relay() {
    [[ -n "$TERMLOOP_SOCKET_PATH" ]] || return 1
    [[ "$TERMLOOP_SOCKET_PATH" == /* ]] && return 1
    [[ "$TERMLOOP_SOCKET_PATH" == *:* ]] || return 1
    [[ -n "$(_termloop_relay_cli_path)" ]]
}

_termloop_has_port_scan_transport() {
    _termloop_socket_is_unix && return 0
    _termloop_socket_uses_remote_relay
}

_termloop_json_escape() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//$'\n'/\\n}"
    value="${value//$'\r'/\\r}"
    value="${value//$'\t'/\\t}"
    printf '%s\n' "$value"
}

_termloop_relay_rpc_bg() {
    local method="$1"
    local params="$2"
    local relay_cli=""
    _termloop_socket_uses_remote_relay || return 1
    relay_cli="$(_termloop_relay_cli_path)" || return 1
    {
        "$relay_cli" rpc "$method" "$params" >/dev/null 2>&1 || true
    } >/dev/null 2>&1 &
    disown 2>/dev/null || true
}

_termloop_relay_rpc() {
    local method="$1"
    local params="$2"
    local relay_cli=""
    local response=""
    _termloop_socket_uses_remote_relay || return 1
    # Relay `termloop rpc` exits nonzero on server error. The real remote CLI prints
    # only the JSON result payload on success, while some test stubs return the
    # full `{"ok":...}` envelope. Retry only on explicit `ok:false`.
    relay_cli="$(_termloop_relay_cli_path)" || return 1
    response="$("$relay_cli" rpc "$method" "$params" 2>/dev/null)" || return 1
    response="${response//$'\n'/}"
    response="${response//$'\r'/}"
    [[ "$response" == *'"ok":false'* || "$response" == *'"ok": false'* ]] && return 1
    return 0
}

_termloop_relay_workspace_id() {
    [[ -n "$TERMLOOP_WORKSPACE_ID" ]] || return 1
    printf '%s\n' "$TERMLOOP_WORKSPACE_ID"
}

_termloop_report_tty_via_relay() {
    _termloop_socket_uses_remote_relay || return 1
    local workspace_id=""
    workspace_id="$(_termloop_relay_workspace_id)" || return 1
    [[ -n "$_TERMLOOP_TTY_NAME" ]] || return 1

    local tty_name_json params
    tty_name_json="$(_termloop_json_escape "$_TERMLOOP_TTY_NAME")"
    params="{\"workspace_id\":\"$workspace_id\",\"tty_name\":\"$tty_name_json\""
    if [[ -n "$TERMLOOP_PANEL_ID" ]]; then
        params+=",\"surface_id\":\"$TERMLOOP_PANEL_ID\""
    fi
    params+="}"
    _termloop_relay_rpc "surface.report_tty" "$params"
}

_termloop_ports_kick_via_relay() {
    local reason="${1:-command}"
    _termloop_socket_uses_remote_relay || return 1
    local workspace_id=""
    workspace_id="$(_termloop_relay_workspace_id)" || return 1
    local params="{\"workspace_id\":\"$workspace_id\",\"reason\":\"$reason\""
    if [[ -n "$TERMLOOP_PANEL_ID" ]]; then
        params+=",\"surface_id\":\"$TERMLOOP_PANEL_ID\""
    fi
    params+="}"
    _termloop_relay_rpc_bg "surface.ports_kick" "$params"
}

_termloop_restore_scrollback_once() {
    local path="${TERMLOOP_RESTORE_SCROLLBACK_FILE:-}"
    [[ -n "$path" ]] || return 0
    unset TERMLOOP_RESTORE_SCROLLBACK_FILE

    if [[ -r "$path" ]]; then
        /bin/cat -- "$path" 2>/dev/null || true
        /bin/rm -f -- "$path" >/dev/null 2>&1 || true
    fi
}
_termloop_restore_scrollback_once
_TERMLOOP_CLAUDE_WRAPPER="${_TERMLOOP_CLAUDE_WRAPPER:-}"
_TERMLOOP_CODEX_WRAPPER="${_TERMLOOP_CODEX_WRAPPER:-}"
_termloop_install_claude_wrapper() {
    local integration_dir="${TERMLOOP_SHELL_INTEGRATION_DIR:-}"
    local existing_type=""
    [[ -n "$integration_dir" ]] || return 0

    integration_dir="${integration_dir%/}"
    local bundle_dir="${integration_dir%/shell-integration}"
    local wrapper_path="$bundle_dir/bin/claude"
    [[ -x "$wrapper_path" ]] || return 0

    existing_type="$(type -t claude 2>/dev/null || true)"
    case "$existing_type" in
        alias|function)
            return 0
            ;;
    esac

    # Keep the bundled claude wrapper ahead of later PATH mutations. Install it
    # via eval so an existing `alias claude=...` cannot break parsing.
    _TERMLOOP_CLAUDE_WRAPPER="$wrapper_path"
    unalias claude >/dev/null 2>&1 || true
    eval 'claude() { "$_TERMLOOP_CLAUDE_WRAPPER" "$@"; }'
}
_termloop_install_claude_wrapper

_termloop_install_codex_wrapper() {
    local integration_dir="${TERMLOOP_SHELL_INTEGRATION_DIR:-}"
    local existing_type=""
    [[ -n "$integration_dir" ]] || return 0

    integration_dir="${integration_dir%/}"
    local bundle_dir="${integration_dir%/shell-integration}"
    local wrapper_path="$bundle_dir/bin/codex"
    [[ -x "$wrapper_path" ]] || return 0

    existing_type="$(type -t codex 2>/dev/null || true)"
    case "$existing_type" in
        alias|function)
            return 0
            ;;
    esac

    _TERMLOOP_CODEX_WRAPPER="$wrapper_path"
    unalias codex >/dev/null 2>&1 || true
    eval 'codex() { "$_TERMLOOP_CODEX_WRAPPER" "$@"; }'
}
_termloop_install_codex_wrapper
_termloop_now() {
    printf '%s\n' "${EPOCHSECONDS:-$SECONDS}"
}

# Throttle heavy work to avoid prompt latency.
_TERMLOOP_PWD_LAST_PWD="${_TERMLOOP_PWD_LAST_PWD:-}"
_TERMLOOP_GIT_LAST_PWD="${_TERMLOOP_GIT_LAST_PWD:-}"
_TERMLOOP_GIT_LAST_RUN="${_TERMLOOP_GIT_LAST_RUN:-0}"
_TERMLOOP_GIT_JOB_PID="${_TERMLOOP_GIT_JOB_PID:-}"
_TERMLOOP_GIT_JOB_STARTED_AT="${_TERMLOOP_GIT_JOB_STARTED_AT:-0}"
_TERMLOOP_GIT_HEAD_LAST_PWD="${_TERMLOOP_GIT_HEAD_LAST_PWD:-}"
_TERMLOOP_GIT_HEAD_PATH="${_TERMLOOP_GIT_HEAD_PATH:-}"
_TERMLOOP_GIT_HEAD_SIGNATURE="${_TERMLOOP_GIT_HEAD_SIGNATURE:-}"
_TERMLOOP_PR_POLL_PID="${_TERMLOOP_PR_POLL_PID:-}"
_TERMLOOP_PR_POLL_PWD="${_TERMLOOP_PR_POLL_PWD:-}"
_TERMLOOP_PR_LAST_BRANCH="${_TERMLOOP_PR_LAST_BRANCH:-}"
_TERMLOOP_PR_NO_PR_BRANCH="${_TERMLOOP_PR_NO_PR_BRANCH:-}"
_TERMLOOP_PR_POLL_INTERVAL="${_TERMLOOP_PR_POLL_INTERVAL:-45}"
_TERMLOOP_PR_FORCE="${_TERMLOOP_PR_FORCE:-0}"
_TERMLOOP_PR_DEBUG="${_TERMLOOP_PR_DEBUG:-0}"
_TERMLOOP_ASYNC_JOB_TIMEOUT="${_TERMLOOP_ASYNC_JOB_TIMEOUT:-20}"
_TERMLOOP_LAST_PR_ACTION="${_TERMLOOP_LAST_PR_ACTION:-}"
_TERMLOOP_LAST_PR_TARGET="${_TERMLOOP_LAST_PR_TARGET:-}"

_TERMLOOP_PORTS_LAST_RUN="${_TERMLOOP_PORTS_LAST_RUN:-0}"
_TERMLOOP_SHELL_ACTIVITY_LAST="${_TERMLOOP_SHELL_ACTIVITY_LAST:-}"
_TERMLOOP_TTY_NAME="${_TERMLOOP_TTY_NAME:-}"
_TERMLOOP_TTY_REPORTED="${_TERMLOOP_TTY_REPORTED:-0}"
_TERMLOOP_TMUX_PUSH_SIGNATURE="${_TERMLOOP_TMUX_PUSH_SIGNATURE:-}"
_TERMLOOP_TMUX_PULL_SIGNATURE="${_TERMLOOP_TMUX_PULL_SIGNATURE:-}"
_TERMLOOP_TMUX_SYNC_KEYS=(
    TERMLOOP_BUNDLED_CLI_PATH
    TERMLOOP_BUNDLE_ID
    TERMLOOP_CUSTOM_CLAUDE_PATH
    TERMLOOPD_UNIX_PATH
    TERMLOOP_REPO_ROOT
    TERMLOOP_DEBUG_LOG
    TERMLOOP_LOAD_GHOSTTY_ZSH_INTEGRATION
    TERMLOOP_PORT
    TERMLOOP_PORT_END
    TERMLOOP_PORT_RANGE
    TERMLOOP_REAL_CLAUDE_PATH
    TERMLOOP_REAL_CODEX_PATH
    TERMLOOP_REMOTE_DAEMON_ALLOW_LOCAL_BUILD
    TERMLOOP_SHELL_INTEGRATION
    TERMLOOP_SHELL_INTEGRATION_DIR
    TERMLOOP_SOCKET_ENABLE
    TERMLOOP_SOCKET_MODE
    TERMLOOP_SOCKET_PATH
    TERMLOOP_TAG
    TERMLOOP_WORKSPACE_ID
)
_TERMLOOP_TMUX_SURFACE_SCOPED_KEYS=(
    TERMLOOP_PANEL_ID
    TERMLOOP_SURFACE_ID
)

_termloop_tmux_sync_key_is_managed() {
    local candidate="$1"
    local key
    for key in "${_TERMLOOP_TMUX_SYNC_KEYS[@]}"; do
        [[ "$key" == "$candidate" ]] && return 0
    done
    return 1
}

_termloop_tmux_shell_env_signature() {
    local key value first=1
    for key in "${_TERMLOOP_TMUX_SYNC_KEYS[@]}"; do
        value="${!key}"
        [[ -n "$value" ]] || continue
        if (( first )); then
            printf '%s=%s' "$key" "$value"
            first=0
        else
            printf '\037%s=%s' "$key" "$value"
        fi
    done
}

_termloop_tmux_publish_termloop_environment() {
    [[ -z "$TMUX" ]] || return 0
    command -v tmux >/dev/null 2>&1 || return 0

    local signature
    signature="$(_termloop_tmux_shell_env_signature)"
    [[ -n "$signature" ]] || return 0
    [[ "$signature" == "$_TERMLOOP_TMUX_PUSH_SIGNATURE" ]] && return 0

    local key value
    for key in "${_TERMLOOP_TMUX_SYNC_KEYS[@]}"; do
        value="${!key}"
        [[ -n "$value" ]] || continue
        tmux set-environment -g "$key" "$value" >/dev/null 2>&1 || return 0
    done

    for key in "${_TERMLOOP_TMUX_SURFACE_SCOPED_KEYS[@]}"; do
        tmux set-environment -gu "$key" >/dev/null 2>&1 || return 0
    done

    _TERMLOOP_TMUX_PUSH_SIGNATURE="$signature"
}

_termloop_tmux_refresh_termloop_environment() {
    [[ -n "$TMUX" ]] || return 0
    command -v tmux >/dev/null 2>&1 || return 0

    local output filtered line key value did_change=0
    output="$(tmux show-environment -g 2>/dev/null)" || return 0

    while IFS= read -r line; do
        [[ "$line" == TERMLOOP_* ]] || continue
        key="${line%%=*}"
        _termloop_tmux_sync_key_is_managed "$key" || continue
        filtered+="${line}"$'\n'
    done <<< "$output"

    [[ -n "$filtered" ]] || return 0
    [[ "$filtered" == "$_TERMLOOP_TMUX_PULL_SIGNATURE" ]] && return 0

    while IFS= read -r line; do
        [[ "$line" == TERMLOOP_* ]] || continue
        key="${line%%=*}"
        _termloop_tmux_sync_key_is_managed "$key" || continue
        value="${line#*=}"
        if [[ "${!key}" != "$value" ]]; then
            printf -v "$key" '%s' "$value"
            export "$key"
            did_change=1
        fi
    done <<< "$filtered"

    _TERMLOOP_TMUX_PULL_SIGNATURE="$filtered"
    if (( did_change )); then
        _TERMLOOP_TTY_REPORTED=0
        _TERMLOOP_SHELL_ACTIVITY_LAST=""
        _TERMLOOP_PWD_LAST_PWD=""
        _TERMLOOP_GIT_LAST_PWD=""
        _TERMLOOP_GIT_HEAD_LAST_PWD=""
        _TERMLOOP_GIT_HEAD_PATH=""
        _TERMLOOP_GIT_HEAD_SIGNATURE=""
        _TERMLOOP_PR_FORCE=1
        _termloop_stop_pr_poll_loop
    fi
}

_termloop_tmux_sync_termloop_environment() {
    if [[ -n "$TMUX" ]]; then
        _termloop_tmux_refresh_termloop_environment
    else
        _termloop_tmux_publish_termloop_environment
    fi
}

_termloop_git_resolve_head_path() {
    # Resolve the HEAD file path without invoking git (fast; works for worktrees).
    local dir="$PWD"
    while :; do
        if [[ -d "$dir/.git" ]]; then
            printf '%s\n' "$dir/.git/HEAD"
            return 0
        fi
        if [[ -f "$dir/.git" ]]; then
            local line gitdir
            IFS= read -r line < "$dir/.git" || line=""
            if [[ "$line" == gitdir:* ]]; then
                gitdir="${line#gitdir:}"
                gitdir="${gitdir## }"
                gitdir="${gitdir%% }"
                [[ -n "$gitdir" ]] || return 1
                [[ "$gitdir" != /* ]] && gitdir="$dir/$gitdir"
                printf '%s\n' "$gitdir/HEAD"
                return 0
            fi
        fi
        [[ "$dir" == "/" || -z "$dir" ]] && break
        dir="$(dirname "$dir")"
    done
    return 1
}

_termloop_git_head_signature() {
    local head_path="$1"
    [[ -n "$head_path" && -r "$head_path" ]] || return 1
    local line
    IFS= read -r line < "$head_path" || return 1
    printf '%s\n' "$line"
}

_termloop_report_tty_payload() {
    [[ -n "$TERMLOOP_WORKSPACE_ID" ]] || return 0
    [[ -n "$_TERMLOOP_TTY_NAME" ]] || return 0

    local payload="report_tty $_TERMLOOP_TTY_NAME --workspace=$TERMLOOP_WORKSPACE_ID"
    if [[ -z "$TMUX" ]]; then
        [[ -n "$TERMLOOP_PANEL_ID" ]] || return 0
        payload+=" --panel=$TERMLOOP_PANEL_ID"
    fi

    printf '%s\n' "$payload"
}

_termloop_report_tty_once() {
    # Send the TTY name to the app once per session so the batched port scanner
    # knows which TTY belongs to this panel.
    (( _TERMLOOP_TTY_REPORTED )) && return 0
    _termloop_has_port_scan_transport || return 0

    if _termloop_socket_is_unix; then
        local payload=""
        payload="$(_termloop_report_tty_payload)"
        [[ -n "$payload" ]] || return 0
        _TERMLOOP_TTY_REPORTED=1
        {
            _termloop_send "$payload"
        } >/dev/null 2>&1 & disown
    else
        [[ -n "$_TERMLOOP_TTY_NAME" ]] || return 0
        # Keep the first relay TTY report synchronous so the server can resolve
        # the target surface before command-start kicks begin their scan burst.
        _termloop_report_tty_via_relay || return 0
        _TERMLOOP_TTY_REPORTED=1
    fi
}

_termloop_report_shell_activity_state() {
    local state="$1"
    [[ -n "$state" ]] || return 0
    [[ -S "$TERMLOOP_SOCKET_PATH" ]] || return 0
    [[ -n "$TERMLOOP_WORKSPACE_ID" ]] || return 0
    [[ -n "$TERMLOOP_PANEL_ID" ]] || return 0
    [[ "$_TERMLOOP_SHELL_ACTIVITY_LAST" == "$state" ]] && return 0
    _TERMLOOP_SHELL_ACTIVITY_LAST="$state"
    {
        _termloop_send "report_shell_state $state --workspace=$TERMLOOP_WORKSPACE_ID --panel=$TERMLOOP_PANEL_ID"
    } >/dev/null 2>&1 & disown
}

_termloop_ports_kick() {
    local reason="${1:-command}"
    # Lightweight: just tell the app to run a batched scan for this panel.
    # The app coalesces kicks across all panels and runs a single ps+lsof.
    _termloop_has_port_scan_transport || return 0
    [[ -n "$TERMLOOP_WORKSPACE_ID" ]] || return 0
    if _termloop_socket_is_unix; then
        [[ -n "$TERMLOOP_PANEL_ID" ]] || return 0
    fi
    _TERMLOOP_PORTS_LAST_RUN="$(_termloop_now)"
    if _termloop_socket_is_unix; then
        {
            _termloop_send "ports_kick --workspace=$TERMLOOP_WORKSPACE_ID --panel=$TERMLOOP_PANEL_ID --reason=$reason"
        } >/dev/null 2>&1 & disown
    else
        _termloop_ports_kick_via_relay "$reason"
    fi
}

_termloop_clear_pr_for_panel() {
    [[ -S "$TERMLOOP_SOCKET_PATH" ]] || return 0
    [[ -n "$TERMLOOP_WORKSPACE_ID" ]] || return 0
    [[ -n "$TERMLOOP_PANEL_ID" ]] || return 0
    # Synchronous: must arrive before the next report_pr from the poll loop.
    _termloop_send "clear_pr --workspace=$TERMLOOP_WORKSPACE_ID --panel=$TERMLOOP_PANEL_ID"
}

_termloop_record_pr_command_hint() {
    local cmd="$1"
    _TERMLOOP_LAST_PR_ACTION=""
    _TERMLOOP_LAST_PR_TARGET=""

    local -a words=()
    read -r -a words <<< "$cmd"

    local index=0
    local word base
    while (( index < ${#words[@]} )); do
        word="${words[index]}"

        case "$word" in
            *=*)
                index=$(( index + 1 ))
                continue ;;
            exec|command|builtin|noglob|time)
                index=$(( index + 1 ))
                continue ;;
            env)
                index=$(( index + 1 ))
                while (( index < ${#words[@]} )); do
                    word="${words[index]}"
                    case "$word" in
                        -*|*=*)
                            index=$(( index + 1 ))
                            continue ;;
                    esac
                    break
                done
                continue ;;
        esac

        base="${word##*/}"
        [[ "$base" == "gh" ]] || return 0
        index=$(( index + 1 ))
        break
    done

    (( index + 1 < ${#words[@]} )) || return 0
    [[ "${words[index]}" == "pr" ]] || return 0
    local action="${words[index + 1]}"
    action="$(printf '%s' "$action" | tr '[:upper:]' '[:lower:]')"
    case "$action" in
        merge|close|reopen|create|checkout|ready|edit|view)
            _TERMLOOP_LAST_PR_ACTION="$action" ;;
        *)
            return 0 ;;
    esac

    index=$(( index + 2 ))
    while (( index < ${#words[@]} )); do
        word="${words[index]}"
        case "$word" in
            --*=*)
                index=$(( index + 1 ))
                continue ;;
            --*)
                index=$(( index + 2 ))
                continue ;;
            -*)
                index=$(( index + 1 ))
                continue ;;
            *)
                _TERMLOOP_LAST_PR_TARGET="$word"
                break ;;
        esac
    done
}

_termloop_emit_pr_command_hint() {
    [[ -S "$TERMLOOP_SOCKET_PATH" ]] || return 0
    [[ -n "$TERMLOOP_WORKSPACE_ID" ]] || return 0
    [[ -n "$TERMLOOP_PANEL_ID" ]] || return 0
    [[ -n "$_TERMLOOP_LAST_PR_ACTION" ]] || return 0

    local payload="report_pr_action $_TERMLOOP_LAST_PR_ACTION --workspace=$TERMLOOP_WORKSPACE_ID --panel=$TERMLOOP_PANEL_ID"
    if [[ -n "$_TERMLOOP_LAST_PR_TARGET" ]]; then
        local quoted_target="${_TERMLOOP_LAST_PR_TARGET//\"/\\\"}"
        payload+=" --target=\"$quoted_target\""
    fi
    {
        _termloop_send "$payload"
    } >/dev/null 2>&1 & disown
    _TERMLOOP_LAST_PR_ACTION=""
    _TERMLOOP_LAST_PR_TARGET=""
}

_termloop_pr_output_indicates_no_pull_request() {
    local output="$1"
    output="$(printf '%s' "$output" | tr '[:upper:]' '[:lower:]')"
    [[ "$output" == *"no pull requests found"* \
        || "$output" == *"no pull request found"* \
        || "$output" == *"no pull requests associated"* \
        || "$output" == *"no pull request associated"* ]]
}

_termloop_github_repo_slug_for_path() {
    local repo_path="$1"
    local remote_url="" path_part=""
    [[ -n "$repo_path" ]] || return 0

    remote_url="$(git -C "$repo_path" remote get-url origin 2>/dev/null)"
    [[ -n "$remote_url" ]] || return 0

    case "$remote_url" in
        git@github.com:*)
            path_part="${remote_url#git@github.com:}"
            ;;
        ssh://git@github.com/*)
            path_part="${remote_url#ssh://git@github.com/}"
            ;;
        https://github.com/*)
            path_part="${remote_url#https://github.com/}"
            ;;
        http://github.com/*)
            path_part="${remote_url#http://github.com/}"
            ;;
        git://github.com/*)
            path_part="${remote_url#git://github.com/}"
            ;;
        *)
            return 0
            ;;
    esac

    path_part="${path_part%.git}"
    [[ "$path_part" == */* ]] || return 0
    printf '%s\n' "$path_part"
}

_termloop_pr_cache_prefix() {
    [[ -n "$TERMLOOP_PANEL_ID" ]] || return 1
    printf '%s\n' "/tmp/termloop-pr-cache-${TERMLOOP_PANEL_ID}"
}

_termloop_pr_force_signal_path() {
    [[ -n "$TERMLOOP_PANEL_ID" ]] || return 1
    printf '%s\n' "/tmp/termloop-pr-force-${TERMLOOP_PANEL_ID}"
}

_termloop_pr_debug_log() {
    (( _TERMLOOP_PR_DEBUG )) || return 0

    local branch="$1"
    local event="$2"
    local now
    now="$(_termloop_now)"
    printf '%s\tbranch=%s\tevent=%s\n' "$now" "$branch" "$event" >> /tmp/termloop-pr-debug.log
}

_termloop_pr_cache_clear() {
    local prefix=""
    prefix="$(_termloop_pr_cache_prefix 2>/dev/null || true)"
    if [[ -n "$prefix" ]]; then
        /bin/rm -f -- \
            "${prefix}.branch" \
            "${prefix}.repo" \
            "${prefix}.result" \
            "${prefix}.timestamp" \
            "${prefix}.no-pr-branch" \
            >/dev/null 2>&1 || true
    fi

    _TERMLOOP_PR_LAST_BRANCH=""
    _TERMLOOP_PR_NO_PR_BRANCH=""
}

_termloop_pr_request_probe() {
    local signal_path=""
    signal_path="$(_termloop_pr_force_signal_path 2>/dev/null || true)"
    [[ -n "$signal_path" ]] || return 0
    : >| "$signal_path"
}

_termloop_report_pr_for_path() {
    local repo_path="$1"
    local force_probe="${2:-0}"
    [[ -n "$repo_path" ]] || {
        _termloop_pr_cache_clear
        _termloop_clear_pr_for_panel
        return 0
    }
    [[ -d "$repo_path" ]] || {
        _termloop_pr_cache_clear
        _termloop_clear_pr_for_panel
        return 0
    }
    [[ -S "$TERMLOOP_SOCKET_PATH" ]] || return 0
    [[ -n "$TERMLOOP_WORKSPACE_ID" ]] || return 0
    [[ -n "$TERMLOOP_PANEL_ID" ]] || return 0

    local branch repo_slug="" gh_output="" gh_error="" err_file="" gh_status number state url status_opt=""
    local now prefix="" branch_file="" repo_file="" result_file="" timestamp_file="" no_pr_branch_file=""
    local cache_branch="" cache_result="" cache_no_pr_branch=""
    local -a gh_repo_args=()
    now="$(_termloop_now)"
    branch="$(git -C "$repo_path" branch --show-current 2>/dev/null)"
    if [[ -z "$branch" ]] || ! command -v gh >/dev/null 2>&1; then
        _termloop_pr_debug_log "$branch" "cache-miss:clear"
        _termloop_pr_cache_clear
        _termloop_clear_pr_for_panel
        return 0
    fi

    prefix="$(_termloop_pr_cache_prefix 2>/dev/null || true)"
    if [[ -n "$prefix" ]]; then
        branch_file="${prefix}.branch"
        repo_file="${prefix}.repo"
        result_file="${prefix}.result"
        timestamp_file="${prefix}.timestamp"
        no_pr_branch_file="${prefix}.no-pr-branch"
        [[ -r "$branch_file" ]] && cache_branch="$(<"$branch_file")"
        [[ -r "$result_file" ]] && cache_result="$(<"$result_file")"
        [[ -r "$no_pr_branch_file" ]] && cache_no_pr_branch="$(<"$no_pr_branch_file")"
    fi

    _TERMLOOP_PR_LAST_BRANCH="$cache_branch"
    _TERMLOOP_PR_NO_PR_BRANCH="$cache_no_pr_branch"
    if [[ "$cache_branch" == "$branch" && -n "$cache_result" ]]; then
        _termloop_pr_debug_log "$branch" "cache-refresh"
    else
        _termloop_pr_debug_log "$branch" "cache-miss"
    fi

    repo_slug="$(_termloop_github_repo_slug_for_path "$repo_path")"
    if [[ -n "$repo_slug" ]]; then
        gh_repo_args=(--repo "$repo_slug")
    fi

    err_file="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/termloop-gh-pr-view.XXXXXX" 2>/dev/null || true)"
    [[ -n "$err_file" ]] || return 1
    gh_output="$(
        builtin cd "$repo_path" 2>/dev/null \
            && gh pr view "$branch" \
                "${gh_repo_args[@]}" \
                --json number,state,url \
                --jq '[.number, .state, .url] | @tsv' \
                2>"$err_file"
    )"
    gh_status=$?
    if [[ -f "$err_file" ]]; then
        gh_error="$("/bin/cat" -- "$err_file" 2>/dev/null || true)"
        /bin/rm -f -- "$err_file" >/dev/null 2>&1 || true
    fi

    if (( gh_status != 0 )) || [[ -z "$gh_output" ]]; then
        if (( gh_status == 0 )) && [[ -z "$gh_output" ]]; then
            if [[ -n "$prefix" ]]; then
                printf '%s\n' "$branch" >| "$branch_file"
                printf '%s\n' "$repo_path" >| "$repo_file"
                printf '%s\n' "$now" >| "$timestamp_file"
                printf '%s\n' "none" >| "$result_file"
                printf '%s\n' "$branch" >| "$no_pr_branch_file"
            fi
            _TERMLOOP_PR_LAST_BRANCH="$branch"
            _TERMLOOP_PR_NO_PR_BRANCH="$branch"
            _termloop_clear_pr_for_panel
            return 0
        fi
        if _termloop_pr_output_indicates_no_pull_request "$gh_error"; then
            if [[ -n "$prefix" ]]; then
                printf '%s\n' "$branch" >| "$branch_file"
                printf '%s\n' "$repo_path" >| "$repo_file"
                printf '%s\n' "$now" >| "$timestamp_file"
                printf '%s\n' "none" >| "$result_file"
                printf '%s\n' "$branch" >| "$no_pr_branch_file"
            fi
            _TERMLOOP_PR_LAST_BRANCH="$branch"
            _TERMLOOP_PR_NO_PR_BRANCH="$branch"
            _termloop_clear_pr_for_panel
            return 0
        fi

        # Always scope PR detection to the exact current branch. Preserve the
        # last-known PR badge when gh fails transiently, then retry on the next
        # background poll instead of showing a mismatched PR.
        return 1
    fi

    IFS=$'\t' read -r number state url <<< "$gh_output"
    if [[ -z "$number" || -z "$url" ]]; then
        return 1
    fi

    case "$state" in
        MERGED) status_opt="--state=merged" ;;
        OPEN) status_opt="--state=open" ;;
        CLOSED) status_opt="--state=closed" ;;
        *) return 1 ;;
    esac

    if [[ -n "$prefix" ]]; then
        printf '%s\n' "$branch" >| "$branch_file"
        printf '%s\n' "$repo_path" >| "$repo_file"
        printf '%s\n' "$now" >| "$timestamp_file"
        printf '%s\t%s\t%s\t%s\n' "pr" "$number" "$state" "$url" >| "$result_file"
        /bin/rm -f -- "$no_pr_branch_file" >/dev/null 2>&1 || true
    fi
    _TERMLOOP_PR_LAST_BRANCH="$branch"
    _TERMLOOP_PR_NO_PR_BRANCH=""

    local quoted_branch="${branch//\"/\\\"}"
    _termloop_send "report_pr $number $url $status_opt --branch=\"$quoted_branch\" --workspace=$TERMLOOP_WORKSPACE_ID --panel=$TERMLOOP_PANEL_ID"
}

_termloop_child_pids() {
    local parent_pid="$1"
    [[ -n "$parent_pid" ]] || return 0
    /bin/ps -ax -o pid= -o ppid= 2>/dev/null | /usr/bin/awk -v parent="$parent_pid" '$2 == parent { print $1 }'
}

_termloop_kill_process_tree() {
    local pid="$1"
    local signal="${2:-TERM}"
    local child_pid=""
    [[ -n "$pid" ]] || return 0

    while IFS= read -r child_pid; do
        [[ -n "$child_pid" ]] || continue
        [[ "$child_pid" == "$pid" ]] && continue
        _termloop_kill_process_tree "$child_pid" "$signal"
    done < <(_termloop_child_pids "$pid")

    kill "-$signal" "$pid" >/dev/null 2>&1 || true
}

_termloop_run_pr_probe_with_timeout() {
    local repo_path="$1"
    local force_probe="${2:-0}"
    local probe_pid=""
    local started_at=""
    local now=""
    started_at="$(_termloop_now)"
    now=$started_at

    (
        _termloop_report_pr_for_path "$repo_path" "$force_probe"
    ) &
    probe_pid=$!

    while kill -0 "$probe_pid" >/dev/null 2>&1; do
        sleep 1
        now="$(_termloop_now)"
        if (( _TERMLOOP_ASYNC_JOB_TIMEOUT > 0 )) && (( now - started_at >= _TERMLOOP_ASYNC_JOB_TIMEOUT )); then
            _termloop_kill_process_tree "$probe_pid" TERM
            sleep 0.2
            if kill -0 "$probe_pid" >/dev/null 2>&1; then
                _termloop_kill_process_tree "$probe_pid" KILL
                sleep 0.2
            fi
            if ! kill -0 "$probe_pid" >/dev/null 2>&1; then
                wait "$probe_pid" >/dev/null 2>&1 || true
            fi
            return 1
        fi
    done

    wait "$probe_pid"
}

_termloop_halt_pr_poll_loop() {
    if [[ -n "$_TERMLOOP_PR_POLL_PID" ]]; then
        # Process-group kill: background jobs are process-group leaders, so
        # negative PID kills the loop + all descendants (gh, sleep) without
        # the synchronous /bin/ps + awk of tree-kill (~5-13ms).
        kill -KILL -- -"$_TERMLOOP_PR_POLL_PID" 2>/dev/null || true
    fi
    local signal_path=""
    signal_path="$(_termloop_pr_force_signal_path 2>/dev/null || true)"
    [[ -n "$signal_path" ]] && /bin/rm -f -- "$signal_path" >/dev/null 2>&1 || true
    _TERMLOOP_PR_POLL_PID=""
    _TERMLOOP_PR_POLL_PWD=""
}

_termloop_stop_pr_poll_loop() {
    _termloop_halt_pr_poll_loop
    _termloop_pr_cache_clear
}

_termloop_start_pr_poll_loop() {
    [[ -S "$TERMLOOP_SOCKET_PATH" ]] || return 0
    [[ -n "$TERMLOOP_WORKSPACE_ID" ]] || return 0
    [[ -n "$TERMLOOP_PANEL_ID" ]] || return 0

    local watch_pwd="${1:-$PWD}"
    local force_restart="${2:-0}"
    local watch_shell_pid="$$"
    local interval="${_TERMLOOP_PR_POLL_INTERVAL:-45}"

    if [[ "$force_restart" != "1" && "$watch_pwd" == "$_TERMLOOP_PR_POLL_PWD" && -n "$_TERMLOOP_PR_POLL_PID" ]] \
        && kill -0 "$_TERMLOOP_PR_POLL_PID" 2>/dev/null; then
        return 0
    fi

    if [[ -n "$_TERMLOOP_PR_POLL_PID" ]] && kill -0 "$_TERMLOOP_PR_POLL_PID" 2>/dev/null; then
        _termloop_halt_pr_poll_loop
    else
        _TERMLOOP_PR_POLL_PID=""
    fi
    _TERMLOOP_PR_POLL_PWD="$watch_pwd"

    {
        local signal_path=""
        signal_path="$(_termloop_pr_force_signal_path 2>/dev/null || true)"
        while :; do
            kill -0 "$watch_shell_pid" 2>/dev/null || break
            local force_probe=0
            if [[ -n "$signal_path" && -f "$signal_path" ]]; then
                force_probe=1
                /bin/rm -f -- "$signal_path" >/dev/null 2>&1 || true
            fi
            _termloop_run_pr_probe_with_timeout "$watch_pwd" "$force_probe" || true

            local slept=0
            while (( slept < interval )); do
                kill -0 "$watch_shell_pid" 2>/dev/null || exit 0
                if [[ -n "$signal_path" && -f "$signal_path" ]]; then
                    break
                fi
                sleep 1
                slept=$(( slept + 1 ))
            done
        done
    } >/dev/null 2>&1 &
    _TERMLOOP_PR_POLL_PID=$!
    disown "$_TERMLOOP_PR_POLL_PID" 2>/dev/null || disown
}

_termloop_bash_cleanup() {
    _termloop_stop_pr_poll_loop
}

_termloop_command_starts_nested_shell() {
    local cmd="$1"
    local -a words=()
    read -r -a words <<< "$cmd"

    local index=0
    local word base
    while (( index < ${#words[@]} )); do
        word="${words[index]}"

        case "$word" in
            *=*)
                index=$(( index + 1 ))
                continue ;;
            exec|command|builtin|noglob|time)
                index=$(( index + 1 ))
                continue ;;
            env)
                index=$(( index + 1 ))
                while (( index < ${#words[@]} )); do
                    word="${words[index]}"
                    case "$word" in
                        -*|*=*)
                            index=$(( index + 1 ))
                            continue ;;
                    esac
                    break
                done
                continue ;;
        esac

        base="${word##*/}"
        case "$base" in
            bash|zsh|sh|fish|nu|nix-shell)
                return 0 ;;
            nix)
                local next_index=$(( index + 1 ))
                local next_word="${words[next_index]:-}"
                case "$next_word" in
                    develop|shell)
                        return 0 ;;
                esac ;;
        esac

        return 1
    done

    return 1
}

_termloop_preexec_command() {
    local cmd="${1:-${BASH_COMMAND:-}}"
    _termloop_tmux_sync_termloop_environment

    local termloop_has_unix_socket=0
    _termloop_socket_is_unix && termloop_has_unix_socket=1
    (( termloop_has_unix_socket )) || _termloop_has_port_scan_transport || return 0
    [[ -n "$TERMLOOP_WORKSPACE_ID" ]] || return 0
    _termloop_record_pr_command_hint "$cmd"

    if [[ -z "$_TERMLOOP_TTY_NAME" ]]; then
        local t
        t="$(tty 2>/dev/null || true)"
        t="${t##*/}"
        [[ -n "$t" && "$t" != "not a tty" ]] && _TERMLOOP_TTY_NAME="$t"
    fi

    _termloop_report_shell_activity_state running
    _termloop_report_tty_once
    _termloop_ports_kick command
    _termloop_halt_pr_poll_loop
    if _termloop_command_starts_nested_shell "$cmd"; then
        return 0
    fi
}

_termloop_bash_preexec_hook() {
    _termloop_preexec_command "$@"
}

_termloop_prompt_command() {
    local last_status=$?
    _termloop_tmux_sync_termloop_environment

    local termloop_has_unix_socket=0
    _termloop_socket_is_unix && termloop_has_unix_socket=1
    (( termloop_has_unix_socket )) || _termloop_has_port_scan_transport || return 0
    [[ -n "$TERMLOOP_WORKSPACE_ID" ]] || return 0

    if [[ -z "$_TERMLOOP_TTY_NAME" ]]; then
        local t
        t="$(tty 2>/dev/null || true)"
        t="${t##*/}"
        [[ "$t" != "not a tty" ]] && _TERMLOOP_TTY_NAME="$t"
    fi

    if [[ -n "$TERMLOOP_PANEL_ID" ]]; then
        _termloop_report_shell_activity_state prompt
    fi
    _termloop_report_tty_once

    local now
    now="$(_termloop_now)"
    if (( ! termloop_has_unix_socket )); then
        if (( now - _TERMLOOP_PORTS_LAST_RUN >= 10 )); then
            _termloop_ports_kick refresh
        fi
        return 0
    fi

    [[ -n "$TERMLOOP_PANEL_ID" ]] || return 0
    local pwd="$PWD"

    # Post-wake socket writes can occasionally leave a probe process wedged.
    # If one probe is stale, clear the guard so fresh async probes can resume.
    if [[ -n "$_TERMLOOP_GIT_JOB_PID" ]]; then
        if ! kill -0 "$_TERMLOOP_GIT_JOB_PID" 2>/dev/null; then
            _TERMLOOP_GIT_JOB_PID=""
            _TERMLOOP_GIT_JOB_STARTED_AT=0
        elif (( _TERMLOOP_GIT_JOB_STARTED_AT > 0 )) && (( now - _TERMLOOP_GIT_JOB_STARTED_AT >= _TERMLOOP_ASYNC_JOB_TIMEOUT )); then
            _TERMLOOP_GIT_JOB_PID=""
            _TERMLOOP_GIT_JOB_STARTED_AT=0
        fi
    fi

    # Resolve TTY name once.
    if [[ -z "$_TERMLOOP_TTY_NAME" ]]; then
        local t
        t="$(tty 2>/dev/null || true)"
        t="${t##*/}"
        [[ "$t" != "not a tty" ]] && _TERMLOOP_TTY_NAME="$t"
    fi

    _termloop_report_tty_once

    # CWD: keep the app in sync with the actual shell directory.
    if [[ "$pwd" != "$_TERMLOOP_PWD_LAST_PWD" ]]; then
        _TERMLOOP_PWD_LAST_PWD="$pwd"
        {
            local qpwd="${pwd//\"/\\\"}"
            _termloop_send "report_pwd \"${qpwd}\" --workspace=$TERMLOOP_WORKSPACE_ID --panel=$TERMLOOP_PANEL_ID"
        } >/dev/null 2>&1 & disown
    fi

    # Branch can change via aliases/tools while an older probe is still in flight.
    # Track .git/HEAD content so we can restart stale probes immediately.
    local git_head_changed=0
    if [[ "$pwd" != "$_TERMLOOP_GIT_HEAD_LAST_PWD" ]]; then
        _TERMLOOP_GIT_HEAD_LAST_PWD="$pwd"
        _TERMLOOP_GIT_HEAD_PATH="$(_termloop_git_resolve_head_path 2>/dev/null || true)"
        _TERMLOOP_GIT_HEAD_SIGNATURE=""
    fi
    if [[ -n "$_TERMLOOP_GIT_HEAD_PATH" ]]; then
        local head_signature
        head_signature="$(_termloop_git_head_signature "$_TERMLOOP_GIT_HEAD_PATH" 2>/dev/null || true)"
        if [[ -n "$head_signature" ]]; then
            if [[ -z "$_TERMLOOP_GIT_HEAD_SIGNATURE" ]]; then
                # The first observed HEAD value is just the session baseline.
                # Treating it as a branch change clears restore-seeded PR badges
                # before the first background probe can confirm the current PR.
                _TERMLOOP_GIT_HEAD_SIGNATURE="$head_signature"
            elif [[ "$head_signature" != "$_TERMLOOP_GIT_HEAD_SIGNATURE" ]]; then
                _TERMLOOP_GIT_HEAD_SIGNATURE="$head_signature"
                git_head_changed=1
                # Also invalidate the PR poller so it refreshes with the new branch.
                _TERMLOOP_PR_FORCE=1
            fi
        fi
    fi

    # Git branch/dirty can change without a directory change (e.g. `git checkout`),
    # so update on every prompt (still async + de-duped by the running-job check).
    # When pwd changes (cd into a different repo), kill the old probe and start fresh
    # so the sidebar picks up the new branch immediately.
    if [[ -n "$_TERMLOOP_GIT_JOB_PID" ]] && kill -0 "$_TERMLOOP_GIT_JOB_PID" 2>/dev/null; then
        if [[ "$pwd" != "$_TERMLOOP_GIT_LAST_PWD" || "$git_head_changed" == "1" ]]; then
            kill "$_TERMLOOP_GIT_JOB_PID" >/dev/null 2>&1 || true
            _TERMLOOP_GIT_JOB_PID=""
            _TERMLOOP_GIT_JOB_STARTED_AT=0
        fi
    fi

    if [[ -z "$_TERMLOOP_GIT_JOB_PID" ]] || ! kill -0 "$_TERMLOOP_GIT_JOB_PID" 2>/dev/null; then
        _TERMLOOP_GIT_LAST_PWD="$pwd"
        _TERMLOOP_GIT_LAST_RUN=$now
        {
            # Skip git operations if not in a git repository to avoid TCC prompts
            git rev-parse --git-dir >/dev/null 2>&1 || return 0
            local branch dirty_opt=""
            branch=$(git branch --show-current 2>/dev/null)
            if [[ -n "$branch" ]]; then
                local first
                first=$(git status --porcelain -uno 2>/dev/null | head -1)
                [[ -n "$first" ]] && dirty_opt="--status=dirty"
                _termloop_send "report_git_branch $branch $dirty_opt --workspace=$TERMLOOP_WORKSPACE_ID --panel=$TERMLOOP_PANEL_ID"
            else
                _termloop_send "clear_git_branch --workspace=$TERMLOOP_WORKSPACE_ID --panel=$TERMLOOP_PANEL_ID"
            fi
        } >/dev/null 2>&1 &
        _TERMLOOP_GIT_JOB_PID=$!
        disown
        _TERMLOOP_GIT_JOB_STARTED_AT=$now
    fi

    if [[ "$git_head_changed" == "1" ]]; then
        _termloop_pr_cache_clear
        _termloop_clear_pr_for_panel
    fi
    if (( last_status == 0 )); then
        _termloop_emit_pr_command_hint
    else
        _TERMLOOP_LAST_PR_ACTION=""
        _TERMLOOP_LAST_PR_TARGET=""
    fi

    # Ports: lightweight kick to the app's batched scanner every ~10s.
    if (( now - _TERMLOOP_PORTS_LAST_RUN >= 10 )); then
        _termloop_ports_kick refresh
    fi
}

_termloop_install_prompt_command() {
    [[ -n "${_TERMLOOP_PROMPT_INSTALLED:-}" ]] && return 0
    _TERMLOOP_PROMPT_INSTALLED=1

    local decl
    decl="$(declare -p PROMPT_COMMAND 2>/dev/null || true)"
    if [[ "$decl" == "declare -a"* ]]; then
        local existing=0
        local item
        for item in "${PROMPT_COMMAND[@]}"; do
            [[ "$item" == "_termloop_prompt_command" ]] && existing=1 && break
        done
        if (( existing == 0 )); then
            PROMPT_COMMAND=("_termloop_prompt_command" "${PROMPT_COMMAND[@]}")
        fi
    else
        case ";$PROMPT_COMMAND;" in
            *";_termloop_prompt_command;"*) ;;
            *)
                if [[ -n "$PROMPT_COMMAND" ]]; then
                    PROMPT_COMMAND="_termloop_prompt_command;$PROMPT_COMMAND"
                else
                    PROMPT_COMMAND="_termloop_prompt_command"
                fi
                ;;
        esac
    fi

        if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
        if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3) )); then
            builtin readonly _TERMLOOP_BASH_PS0='${ _termloop_bash_preexec_hook "$BASH_COMMAND"; }'
        else
            builtin readonly _TERMLOOP_BASH_PS0='$(_termloop_bash_preexec_hook "$BASH_COMMAND" >/dev/null)'
        fi
        if [[ "$PS0" != *"${_TERMLOOP_BASH_PS0}"* ]]; then
            PS0=$PS0"${_TERMLOOP_BASH_PS0}"
        fi
    fi
}

_termloop_bundled_bin_dir() {
    if [[ -n "${GHOSTTY_BIN_DIR:-}" ]]; then
        local gui_dir="${GHOSTTY_BIN_DIR%/}"
        local bin_dir="${gui_dir%/MacOS}/Resources/bin"
        if [[ -d "$bin_dir" ]]; then
            printf '%s\n' "$bin_dir"
            return 0
        fi
    fi

    if [[ -n "${TERMLOOP_SHELL_INTEGRATION_DIR:-}" ]]; then
        local integration_dir="${TERMLOOP_SHELL_INTEGRATION_DIR%/}"
        local bin_dir="${integration_dir%/shell-integration}/bin"
        if [[ -d "$bin_dir" ]]; then
            printf '%s\n' "$bin_dir"
            return 0
        fi
    fi

    return 1
}

# Ensure Resources/bin is at the front of PATH, and remove the app's
# Contents/MacOS entry so the GUI termloop binary cannot shadow the CLI termloop.
# Shell init (.bashrc/.bash_profile) may prepend other dirs after launch.
_termloop_fix_path() {
    local bin_dir=""
    bin_dir="$(_termloop_bundled_bin_dir)"
    if [[ -n "$bin_dir" ]]; then
        local gui_dir="${GHOSTTY_BIN_DIR:-}"
        gui_dir="${gui_dir%/}"
        local new_path=":${PATH}:"
        new_path="${new_path//:${bin_dir}:/:}"
        if [[ -n "$gui_dir" ]]; then
            new_path="${new_path//:${gui_dir}:/:}"
        fi
        new_path="${new_path#:}"
        new_path="${new_path%:}"
        PATH="${bin_dir}:${new_path}"
    fi
}
_termloop_fix_path
unset -f _termloop_fix_path

_termloop_detect_send_tool

_termloop_install_prompt_command
