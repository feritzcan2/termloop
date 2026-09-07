# Invocation agent rules

## Ownership

- Own the visible template catalog, typed bindings, delivered-form composition,
  preview, transport adapters, and the only constructor for `LaunchPayload`.
- Prompt assets live under `resources/prompts/` and are part of this boundary.

## Dependencies

- Allowed internal dependencies: `domain`, `agents`, `platform`.
- No process spawn, durable store, core policy, providers, or clients.

## Invariants

- All TermLoop-authored prompt prose and model-facing instructions are written
  in English; user-provided multilingual content remains an explicit binding.
- Every TermLoop-generated launch resolves to `templateRef + bindings` and a
  user-visible delivered preview. A non-empty arbitrary string is not provenance.
- No production inline/fallback prompt. Add or change the visible asset instead.
- `LaunchPayload` construction remains inaccessible outside this module.
- Every agent launch resolves one `ResolvedLaunchManifest`; its public inspector
  and private `LaunchPayload` projections share ordered parts and delivery
  semantics. Adapters cannot append content or launch configuration afterward.
- Inspector redaction is typed during manifest construction. Never serialize a
  private payload and redact it downstream.
- Runtime environment additions are a narrow, non-secret allowlist. Tokens stay
  out of argv, previews, durable process descriptors, logs, and errors. Claude
  MCP launch uses a private secret-free config path; Codex arguments carry only
  the non-secret URL and bearer-variable name.
- `--dangerously-bypass-hook-trust` must never reach a production launch path;
  CI enforces this module boundary through `AGENT_TRUST_BYPASS`.
- Resume uses a pinned compatible template/version contract; it cannot silently
  pick up unrelated template changes.
- A resumed Ask-To helper keeps the helper launch profile. If an exact current
  request survived interruption, its manifest includes the visible versioned
  recovery asset; TermLoop never reconstructs or stores the answer text.
- Resume revalidates and reapplies the current Session's saved model, permission,
  and reasoning selection; it never silently replaces that selection with
  defaults.
- Native conversation fork uses the same visible interactive template and adds
  no generated prompt; only invocation may compose its private provider argv.
- Direct user terminal input is outside prompt provenance.
- Every accepted generated terminal input—launch/resume initial input, Ask-To
  request/follow-up/final reply, handover and agent message, Task assignment,
  Steward/Companion/Worker message or wake, and any future equivalent—must be
  composed here as one immutable, provenance-bearing
  `GeneratedTerminalSubmission`. Compose every visible prompt and terminal-safe
  submission byte here; no later layer may append, replay, or recompose it.
- Task assignment may render an optional canonical Jira URL supplied
  from core's sidecar projection; an absent URL must not change delivered text.
- Agent-specific environment additions are explicit, runtime-only, and visible
  by key in delivered preview. Values and ambient daemon variables are never
  exposed through preview or diagnostics.
- Persistent Stewards use the inspectable `bypassPermissions` mapping.
  Workers and ordinary Agents retain their selected/default permission mode.
- Steward visible instructions classify conversation output explicitly and
  leave successful action receipts to TermLoop's command boundary.
- Steward visible instructions permit self-prompt replacement only from the
  exact newest user-authored Project chat message. They require reading the
  complete editable source, interpreting the request as an edit, preserving
  unaffected text, and submitting the complete modified document. The
  authenticated tools and Core provenance/source checks remain the authority,
  never the prompt text.
- Every Steward manifest composes the visible built-in runtime
  and safety layer before the editable Project instructions. A custom value may
  tune PM behavior but cannot erase initial-launch/wake reply handling.

## Verification

- Run `cargo test -p termloop-invocation`.
- Run `pnpm architecture:boundaries`.
- Add tests comparing preview bytes with the actual delivered payload.
