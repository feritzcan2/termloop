# TermLoop Fork Discipline

This directory documents the rules and workflow that keep `termloop` conflict-free against upstream `feritzcan2/termloop` pulls.

## TL;DR for contributors

- **New code** goes under `Sources/TermLoop/` (never under `Sources/` directly).
- **Editing an upstream file** requires the hook pattern — read `hook-patterns.md` first.
- **Pulling upstream** is done via the `/sync-upstream` slash command (see `sync-workflow.md`).

## Files in this directory

- `isolation-rules.md` — the full catalog of K1–K4 rules and Y1–Y4 prohibitions.
- `hook-patterns.md` — the four permitted hook types and how to apply them.
- `sync-workflow.md` — the `/sync-upstream` procedure and conflict triage table.
- `hooks-inventory.md` — catalog of all hook points currently in upstream files.
- `default-agent-template-standard.md` — quality and source rules for built-in agent templates.

## Product framing

**TermLoop** is our AI-first macOS terminal product. It is built on top of
[cmux](https://github.com/feritzcan2/termloop) by manaflow-ai, which is used as
upstream infrastructure. All product-specific code lives under `Sources/TermLoop/`.
The termloop source tree is periodically synced via `/sync-upstream`.
