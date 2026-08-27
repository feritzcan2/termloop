# LLM gateway agent rules

## Ownership

- Own capability-scoped daemon transport to supported LLM providers.
- Accept provenance-bearing invocation envelopes and return normalized transport
  responses or typed failures.

## Dependencies

- Allowed internal dependency: `platform` only.
- No `core`, `store`, domain truth, prompt authoring, Companion policy, or UI.

## Invariants

- Credentials are acquired from `platform` and never cross the protocol boundary.
- Do not accept arbitrary endpoints, headers, or raw credential material from an
  unprivileged client.
- This module transports prompts; it does not invent, persist, or authorize them.
- LLM output is untrusted opinion. A Steward Task-create request remains
  ephemeral until a full-control user confirmation composes the ordinary Core
  command; the LLM transport never authorizes it.

## Verification

- Run `cargo test -p termloop-llm`.
- Test capability denial, credential redaction, provider failure, and cancellation.
