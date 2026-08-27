# F1 agent-signal spike report

Status: **MIXED**

Generated: 2026-08-08T19:59:22.745Z

| Agent | Exit | Runtime correlation | Awaiting-input signal | Observed hooks |
|---|---:|---|---|---|
| claude | 0 | yes | no | PostToolUse, PreToolUse, SessionEnd, SessionStart, Stop, UserPromptSubmit |
| codex | 0 | yes | yes | PostToolUse, PreToolUse, SessionEnd, SessionStart, Stop, UserPromptSubmit |

## Decision

Only part of the required signal surface was observed. F1-03B must preserve explicit unknown states and limit product claims to the observed agent/event combinations.

## Measurement boundary

- Real installed CLIs were invoked in an isolated temporary Git repository.
- Claude loaded an explicit temporary `--settings` file with setting sources restricted to the temporary project.
- Codex lifecycle hooks used invocation-local config overrides with one-invocation hook-trust bypass and user config ignored. Its approval path was observed independently as the structured server-initiated request from a temporary-profile App Server session.
- Hook payloads were sanitized at capture time. Tokens, prompts, raw model output, full tool input, transcript paths, and temporary paths are absent from this evidence.
- A captured `PermissionRequest` or `Notification` is treated as an authoritative awaiting-input-capable signal. Terminal text was not parsed.

## Limitations

- This spike proves the installed CLI behavior on one macOS host; it is not cross-platform evidence.
- A hook can self-report only presentation state; it is not an authorization boundary.
- Production hook delivery, per-Session credential validation, reducers, and UI notifications are intentionally not implemented here.
