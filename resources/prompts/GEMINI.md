# Prompt asset agent rules

## Ownership

- This directory contains every TermLoop-authored prompt that may be delivered
  to an agent, including built-ins, Quick Actions, Task launch, resume helpers,
  and Companion-authored launch templates.

## Invariants

- No hidden or inline fallback prompt may exist in production code.
- Every delivered prompt has a stable template reference, explicit bindings, and
  a user-visible preview of the delivered form.
- Direct user keystrokes in a terminal are not prompt assets.
- Development fixtures cannot become a private production prompt path.

## Verification

- Run `cargo test -p termloop-invocation`.
- Run `pnpm architecture:boundaries` and the relevant launch acceptance test.
