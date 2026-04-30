# TermLoop Isolation Rules

Custom code in `termloop` must be isolated from upstream termloop source code.
This enables conflict-free upstream pulls.

## K-Rules (Keep discipline)

- **K1:** New Swift files always go under `Sources/TermLoop/<subfolder>/`. Never directly under `Sources/`.
- **K2:** No new functions, methods, or properties inside upstream file bodies. Use Swift extensions in `Sources/TermLoop/Hooks/`.
- **K3:** Upstream files may only contain single-line hook calls wrapped in marker blocks (see `hook-patterns.md`).
- **K4:** Custom localization keys go in `Resources/TermLoop.xcstrings`. `Resources/Localizable.xcstrings` stays upstream-only.

## Y-Rules (Yasak — prohibitions)

- **Y1:** No multi-line blocks inside an upstream function body. Delegate to a single `TermLoopHooks.xxx(...)` call.
- **Y2:** Don't rename upstream variables or parameters.
- **Y3:** Don't add new branches (`if`/`else`/`switch`) to upstream control flow. Decide inside the hook.
- **Y4:** No stored properties added to upstream class bodies. Use `WorkspaceMetadataStore` pattern.

## Exception mechanism (rare, hard)

A Y4 exception is allowed only when all three hold:
1. No equivalent store/extension pattern is feasible, with written rationale.
2. The maintainer explicitly approves the exception in the PR description.
3. The commit message contains an `termloop-exception: <reason>` trailer, and
   `docs/termloop/exceptions.md` (created when the first exception is needed) gets a new entry.

## What "upstream file" means in practice

An upstream file is any tracked file NOT under:
- `Sources/TermLoop/**`
- `CLI/TermLoop/**`
- `Resources/TermLoop.xcstrings`
- `docs/termloop/**`
- `.claude/commands/sync-upstream.md`
