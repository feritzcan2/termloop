---
name: find-scattered-orchestration
description: Scan a codebase for write-side orchestration that has drifted across multiple call sites and propose a single coordinator/lifecycle layer to consolidate it. Use when the user asks to "look for refactor opportunities", "find scattered logic", "consolidate write paths", "centralize state transitions", or describes symptoms like "this same sequence is everywhere".
---

# Find scattered write-side orchestration

You are scanning a codebase for a refactor opportunity: write-side
operations (state transitions, side-effects, dispatch) whose ordering,
policy branching, and paired side-effects have drifted across multiple
call sites. The fix is almost always one coordinator/lifecycle layer
that owns the decisions and ordering, with pure helpers underneath.

This pattern is language-agnostic. It shows up in HTTP handlers
(repeated validate → persist → publish-event sequences), state-machine
transitions, transaction commit/rollback pairings, queue/job dispatch,
cache invalidation, file-resource lifecycles — anywhere the same shape
gets re-spelled across files.

## What to look for

Any 2+ together is a strong signal:

1. **Repeated sequences** — 3+ files do `mutate(X) → flush(Y) → dispatch(Z)`
   in the same order, each spelling it inline.
2. **Duplicated policy branches** — the same `if type == "X" { ... } else
   { ... }` (or feature-flag check, or capability check) appears in 2+
   unrelated files. The decision is copy-pasted.
3. **Split paired operations** — a write that *must* be followed by a
   flush / notify / save / commit, where the pairing depends on each
   caller remembering. Find pairs like `update*` → `save*`, `enqueue*` →
   `flush*`, `set*` → `notify*` and check whether any caller skips the
   second half.
4. **Mixed orchestration + composition** — a module exposes both pure
   helpers (`buildFoo`, `composeFoo`) and stateful entry points (`runFoo`
   that mutates state, schedules work, fires events). The orchestration
   belongs in a separate layer; only the pure helpers should remain.
5. **Hook / observer doing real work** — an `onSomethingCreated`,
   `bindXOnY`, `afterCreate`, or middleware that runs a multi-step
   decision chain instead of delegating to one owner.
6. **Race-prone ordering** — comments like "must call X before Y",
   `TODO: ordering`, or callers that quietly reorder without realizing
   the cost.

## What is NOT a finding

- Different operations that share a verb. Same shape ≠ same intent.
- Single-call-site sequences. Drift requires multiplicity.
- Read-side helpers (formatting, queries, derived views, selectors,
  serializers). This pattern applies only to write-side state transitions.
- Two callers whose divergence is correct (e.g. migration path vs fresh
  path that legitimately differ). Don't collapse intentional differences.

## How to investigate

1. Pick a verb that smells central in this codebase (`create`, `submit`,
   `dispatch`, `commit`, `apply`, `transition`, `move`, `attach`). Grep
   every implementation site — don't assume.
2. For each site, record: ordered side-effects, policy branches, helpers
   called. A small table is enough.
3. **Canonical sequence** = the longest common ordered subsequence
   across sites. That's the lifecycle method that should exist.
4. **Policy axis** = the decision being repeated (`is X type`, `is flag
   on`, `is state Y`). Collapses into one helper.
5. **Paired-ops invariants** = A → B that must always fire together.
   Each pair becomes one atomic helper.
6. **Mixed module** = anything doing both orchestration and pure
   composition. Split: orchestration moves out, helpers stay.

## Output

File:line for every finding. No abstract bullets without anchors.

- **Drift summary** — 2–3 sentences on the actual scattered pattern.
- **Sites involved** — bullets with file:line.
- **Proposed lifecycle shape** — public methods to add and what each
  owns. Describe the API; don't write the code.
- **Hard rules to encode** — invariants the new layer enforces (e.g.
  "X is always written before Y").
- **What stays put** — what existing modules keep doing, so the refactor
  doesn't sprawl into "rewrite everything".
- **Migration order** — pick the *hardest* caller first (most policy +
  ordering); easy callers will fit whatever API survives the hard one.
- **Known structural debt** — any caller you *can't* migrate cleanly
  and why (third-party code, framework constraints, ownership rules
  imposed by the project). Flag it; don't pretend it'll fall to the
  same refactor.

Stay under 800 words.

## Project context (gather before running)

Before starting, confirm with the user (or infer from CLAUDE.md / repo
structure if obvious):

- Primary language(s) / runtime
- Domain area to focus on (e.g. "order checkout", "background job
  pipeline", "device session state")
- Modules / paths / globs to start scanning
- Out-of-scope (already-clean or actively-being-refactored)
- Project-specific ownership rules to respect (e.g. "no logic in
  controllers", "framework callbacks must stay one-liners")
