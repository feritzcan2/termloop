# 08 — Repository layout

Designed so the **names and boundaries are fixed** while the **stack mechanism stays open**. Whether `modules/*` are Rust crates, TypeScript packages, or Go modules changes the manifest files and nothing else in this document.

```
/contract/
  schema/                  ← human-owned, branch-protected
  generated/               ← checked in AND regenerated in CI
    <lang-a>/  <lang-b>/

/modules/                  ← one directory per module; unit TBD (crate | package | module)
  domain/
  platform/
  gitio/
  providers/
  agents/
  invocation/
  store/
  terminal/
  observability/
  core/
  companion/
  server/

/clients/
  desktop/
  cli/
  mobile/                  ← placeholder; scope unsettled

/tests/
  contract/                ← one conformance suite per module
  e2e/                     ← cross-platform scenario tests, mirrors skeleton steps

/tools/
  codegen/                 ← schema → generated clients
  ci/                      ← purity, DAG, vocabulary, prompt-provenance checks

/oracle/
  scenarios/               ← written flows captured from the current product
  session-logs/            ← real agent session corpus for replay diffing

/docs/                     ← this packet
```

## Layout invariants

- **A module directory's dependency declaration is the enforcement point** for the DAG in [02-MODULES](02-MODULES.md). The purity CI job reads these, so a violation is a build failure rather than a review comment.
- `contract/generated/` is never hand-edited.
- `tests/contract/` has exactly one suite per module. A module without a suite cannot be marked done.
- `/oracle/` is data only. Nothing in the build depends on it; it exists for replay diffing.
- `clients/*` may depend only on `contract/`.

## What this layout deliberately avoids

- **A single monolithic package.** Ownership per module is the mechanism that lets agents work in parallel without colliding.
- **Dozens of micro-packages.** Twelve is already at the upper edge of useful. A module that only re-exports another module should be merged.
- **A `common/` or `utils/` module.** It becomes the place every dependency rule goes to die. Shared pure helpers belong in `domain`; shared OS helpers belong in `platform`. There is no third option.
- **Per-platform source trees.** `platform/` internally branches per OS; the rest of the tree is platform-free. Three parallel client implementations is the cost this avoids.

## Stack decisions that remain open

Marked so nothing in this packet silently assumes an answer.

| Decision | Status | Blocks |
|---|---|---|
| Core language for daemon modules | **open** | packaging mechanism only |
| Frontend shell (native / webview / hybrid) | **open** | `clients/desktop` |
| VT engine, and whether **one** engine serves daemon + renderer | **open — highest technical risk** | skeleton S2 |
| Data-plane framing (per-session stream vs binary multiplex) | open | skeleton S1 |
| Codegen toolchain | open | `tools/codegen` |
| IPC transport specifics per OS | open | `platform`, `server` |
| Whether mobile stays in scope | **product-open** | `clients/mobile` |

Everything else in this packet — the module set, the DAG, the domain model, the ten cross-cutting rules, the skeleton order — is **stack-independent** and can be reviewed and agreed before any of the above is chosen.

The one coupling worth naming: the VT-engine decision and the core-language decision are **linked**. Serving the daemon's checkpoint engine and the renderer's display engine from one implementation constrains which languages are viable. That coupling should be resolved as a single decision, not two.
