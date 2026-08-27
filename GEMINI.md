# TermLoop agent rules

TermLoop is a cross-platform, terminal-first application whose daemon owns PTYs
and durable state while generated protocols serve Electron, CLI, Companion, and
remote clients.

## Essentials

- The JavaScript and TypeScript package manager is `pnpm@10.14.0`.
- Bootstrap with `pnpm install --frozen-lockfile`, then run `pnpm codegen`.
- There is no single repository-wide build command. Use the nearest local
  `AGENTS.md` for package-specific build and type-check commands.
- `pnpm check` runs the full repository static-validation suite; `pnpm test`
  runs the full repository test suite.
- Before editing, read the nearest local `AGENTS.md`. For a cross-boundary
  change, read every affected boundary's `AGENTS.md`.
- Source code, schemas, tests, and applicable agent rules are authoritative. A
  nested `AGENTS.md` may narrow these repository rules for its boundary but may
  not weaken them.
- Work only in paths required by the user request. Preserve unrelated and
  pre-existing changes; never reset or overwrite another agent's work.
- Do not create `common/`, `shared/`, or `utils/`. Pure shared concepts belong
  in `domain`; daemon OS primitives belong in `platform`; otherwise keep code
  with its owner.
- Repository documentation is intentionally not maintained. Create or edit it
  only when the user explicitly requests documentation work. If documentation
  disagrees with executable sources, follow the executable sources and mention
  the mismatch without pausing the requested implementation.
- Before extending a production file beyond roughly 1,000 non-test lines or
  adding a second independently changing responsibility, assess an intra-module
  split as a separate refactor slice. Do not mix a mechanical split with
  behavior, schema, contract, ownership, or DAG changes.
- Add or update focused tests for changed behavior and invariants. For a small
  change confined to one module, run only its local checks, directly affected
  tests, and package type-check. Use `pnpm check` and `pnpm test` only for
  multi-module, schema, generated-code, platform, shared-build changes, or when
  the user requests them. Do not rerun an unchanged broad check on the same
  commit unless relevant files changed after its successful result.
- Keep command output bounded but preserve exit status, summaries, and complete
  failing diagnostics. The final response lists changed paths, commands and
  results, skipped or unmeasured cases, remaining risks, and material
  assumptions.

## Operational rules

- Before running the development app, read [tools/dev/AGENTS.md](tools/dev/AGENTS.md).
- Before integrating into `main`, dispatching GitHub Actions, or releasing,
  read [.github/AGENTS.md](.github/AGENTS.md).
