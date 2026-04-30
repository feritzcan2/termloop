# Brand — TermLoop

Product formerly known as **termloop** (cmux fork). Rebranded to **TermLoop** on 2026-04-23.

Positioning: **terminal-first agent IDE for developers**. Parallel AI agents, built-in git worktrees, mobile bridge.

## Domain portfolio

| Domain | Status | Registrar | Yearly | Purchased |
|---|---|---|---|---|
| `termloop.ai` | PRIMARY | Cloudflare | TBD | 2026-04-23 |
| `termloop.com` | unknown | — | — | — |
| `termloop.io` | unknown | — | — | — |
| `termloop.dev` | unknown | — | — | — |
| `termloop.run` | unknown | — | — | — |
| `termloop.app` | unknown | — | — | — |

## Handles

| Platform | Handle | Acquired | Notes |
|---|---|---|---|
| GitHub org | `termloopai` | 2026-04-23 | Brand org/handle target. URL: github.com/termloopai |
| X / Twitter | — | — | TODO |
| Bluesky | — | — | TODO |
| Discord | — | — | TODO |

Repo naming convention under `github.com/termloopai/`:
- `termloopai/app` — macOS app (the termloop rename target)
- `termloopai/mobile` — iOS/Android mobile client (terminal-app)
- `termloopai/docs` — public documentation site
- `termloopai/.github` — org-wide profile README

## Known collisions / risks

- Brand spelling: user-facing **TermLoop**, compact handle **termloop**.

## Rename scope (deferred, do NOT do pre-launch)

Current codebase identifiers to eventually migrate:
- `termloop/Sources/TermLoop/` → eventually `Sources/TermLoop/`
- `termloop/CLI/TermLoop/` → `CLI/TermLoop/`
- Socket password file path: `~/Library/Application Support/cmux/socket-control-password`
- Bundle ID, app display name, CLI binary name

Keep `termloop` internal name stable until brand launch is ready. Rename in a single coordinated PR.

## Tagline candidates (draft)

- "The terminal built for AI agents."
- "Loop your agents. Keep your terminal."
- "Parallel agents, one terminal."
- "A terminal IDE for agentic workflows."

(Refine closer to launch.)

## Licensing reality (factual — see termloop/LICENSE)

Upstream `manaflow-ai/cmux` is **GPL-3.0-or-later** with a commercial dual-license held by Manaflow, Inc. Contributors sign an asymmetric CLA granting Manaflow sublicensing rights. This determines what downstream works (including TermLoop) can legally do.

Ghostty fork (`termloop/ghostty/`) license: verify before relying on it.

## Landing page language

All "MIT" and "Open source" claims removed on 2026-04-17. Page uses "source-available" and defers final licensing to launch. **Do NOT re-add permissive-license claims** on the public landing without re-verifying the legal path.

---

> **Internal strategy (monetization model, pricing tiers, feature gates, legal safety rules, rollout sequence) is intentionally NOT in this file.** It lives in the author's private Claude auto-memory (`~/.claude/projects/.../memory/`) and is never checked into any repo.
