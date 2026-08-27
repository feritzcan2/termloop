# Agents agent rules

## Ownership

- Own the agent catalog, adapter capabilities, hook/App-Server ingestion, pure
  status reduction, permission-mode write-capability classification, and one
  current resume pointer per live/resumable Session, and launch-local HTTP MCP
  support facts. Claude support is help-flag proven; Codex uses the measured
  minimum semantic version and unknown versions degrade. Exact Codex
  `thread/settings/updated` facts may map to the existing closed replayable
  permission modes; custom or inconsistent profiles degrade without mutation.

## Dependencies

- Allowed internal dependencies: `domain`, `platform`.
- No prompt composition, durable store access, core policy, providers, clients,
  or per-Task session history.
- The only permitted process execution is capability discovery through
  `platform`. It must use bounded primitives; legacy `probe_command` is boundary
  debt, not a template. Never spawn, own, or supervise an agent Session here.

## Invariants

- Write capability is an observed classification used for projections and
  warnings; it never gates launch.
- A multiplexed hook event is classified by its provider-supplied type first:
  only a real attention request becomes `AwaitingInput`, an idle nudge becomes
  `Idle`, and an ambient notice keeps the previous state. Unrecognised types stay
  attention-bearing.
- Status derives from authoritative hooks/session facts and degrades honestly
  when a provider lacks a signal.
- The process-owned status seed applies only to an exact observed
  `working` Claude/Codex Session during a validated bounded graceful
  daemon-restart handoff, or Codex during same-daemon replacement. It becomes
  interrupted, never carried working. Process exit, crash recovery, and missing
  observations never imply interruption.
- Status never derives from terminal/PTY text. CI forbids terminal byte/event
  inputs in this module through `AGENT_TERMINAL_INPUT`.
- Observation instrumentation is best-effort: unsupported versions or missing
  signals degrade to a vanilla launch with `unknown`, never a dead launch or a
  weakened provider trust setting.
- Resume metadata is a single current pointer, not a list or attempt timeline.
- Native fork support is an exact discovered capability; never infer it from
  provider name, transcript files, cwd, or terminal text.
- Hook payloads are validated and bounded before use.
- Provider bridges forward frames transparently and never own or persist the
  provider process, credentials, prompts, or transcript.
- Terminal text, logs, partial settings, and a profile name without consistent
  effective settings never become permission-change authority.

## Verification

- Run `cargo test -p termloop-agents`.
- Extend the in-crate reducer and bridge tests in `src/lib.rs`. A shared replay
  corpus and `termloop-agent-replay-tests` crate do not exist yet; do not create
  either as incidental scaffold.
