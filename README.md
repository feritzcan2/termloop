# TermLoop

Cross-platform, terminal-first TermLoop rewrite.

## Bootstrap

Requirements: Rust 1.90, Node 22+, pnpm 10.14.

```sh
pnpm install --frozen-lockfile
pnpm codegen
pnpm check
pnpm test
```

The daemon owns PTYs and durable state. Electron, CLI, Companion, and later remote clients use the generated protocol. Repository-local `AGENTS.md` files contain the engineering rules for each code boundary.

## Current milestone

S0 and the first F0 product slice are implemented. The daemon can persist Projects, own shell/Claude/Codex PTYs, preserve logical Session identity across client detach/re-attach, and expose separate generated control and binary terminal planes to CLI and sandboxed Electron clients. R0 has a local macOS `PROVISIONAL-GO`; physical-pixel evidence and native hosted Windows/Linux runs remain before final stack sign-off.

Generated local evidence is written under `artifacts/evidence/` and is not maintained as repository documentation.
