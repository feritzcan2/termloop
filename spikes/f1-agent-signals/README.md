# F1 agent-signal spike

This disposable spike answers two questions before the F1-03 contract is
proposed:

1. Can Claude Code load a TermLoop-owned settings file, propagate an
   in-memory Session marker to hook commands, and expose lifecycle/approval
   facts without changing user or project settings?
2. Can the installed Codex CLI expose the same facts through its documented
   hook surface, especially `PermissionRequest`, without parsing terminal
   text or relying on persisted rollout history?

Run:

```sh
pnpm f1:agent-signal-spike
```

The runner creates an isolated temporary project and settings files, invokes
the real installed CLIs, sanitizes hook payloads, writes machine-readable
evidence to `evidence.json`, derives `REPORT.md`, and deletes the temporary
directory. It never edits `~/.claude`, `~/.codex`, or the repository's agent
configuration.

The spike is not a production API. Production code must not depend on it.

