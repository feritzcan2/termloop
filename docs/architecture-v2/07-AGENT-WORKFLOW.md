# 07 — Agent development workflow

The governing constraint: **coding agents cannot coordinate with each other.** The architecture must make coordination unnecessary rather than asking for it.

A related and easily missed point: parallel agent throughput is rarely the bottleneck — **integration and verification are.** The real limit is how fast a human can validate agent output. Optimize for verifiability and parallelism follows. Optimize for parallelism first and you get twelve modules that each pass their own tests and do not compose.

---

## Module ownership

- **One owner per module.** Never two agents inside one module concurrently.
- An agent's working set is: its module, that module's conformance suite, and `contract/` **read-only**.
- Cross-module work is decomposed by a human into per-module slices before any agent starts.
- `contract/` and `05-PERSISTENCE.md`'s inventory table have no agent owner. Humans only.

## Contract changes

The gate that makes everything else safe.

1. An agent that needs a contract change writes a **proposal document** — the shape, why, and what breaks.
2. A human accepts or rejects, and commits the schema change themselves.
3. CI regenerates clients; drift fails the build.
4. Only then may implementing slices proceed.

An agent may not commit to `contract/schema/`. Branch protection, not etiquette.

## Vertical slices

A legal slice touches:

- exactly **one** module,
- that module's conformance tests,
- and nothing in `contract/` (beyond reading it).

A change that needs two modules is two slices with a contract change between them, sequenced by a human. This is slower per feature and dramatically faster per *working* feature.

Slice by **capability, not by layer.** Layered slicing makes every feature cut across every module, so every feature needs every agent — which is the coordination problem returning by the back door.

## Review and integration loop

```
spec  →  build  →  adversarial review  →  integrate  →  human merge
         (owner)   (different agent)      (all suites)
```

- **Adversarial review is done by a different agent than the author**, and is prompted to *refute*, checking the implementation against that module's numbered invariant list from [02-MODULES](02-MODULES.md) — not against general taste.
- **Integration** runs every module's conformance suite against the real assembled daemon, not against mocks.
- **Humans merge.** Always.

## Definition of done

A slice is done when **all** hold:

1. Module conformance suite green.
2. Builds and tests pass on macOS, Windows, Linux.
3. No new OS conditional outside `platform/`.
4. No new durable field without a line in the [05-PERSISTENCE](05-PERSISTENCE.md) inventory.
5. Purity/DAG CI job green.
6. Prompt-provenance CI check green.
7. Every invariant the slice touches has a test that fails if the invariant is removed.
8. No new retired-vocabulary term (`Workspace`, `Run`, `Attempt`, history, lease) anywhere in code or docs.

"The agent says it works" is not on this list.

## CI matrix

| Job | Runs on | Asserts |
|---|---|---|
| unit | 3 OS | per-module tests |
| conformance | 3 OS | module suites against the real daemon |
| e2e-skeleton | 3 OS | current skeleton steps still pass |
| **purity/DAG** | 1 OS | `domain` has no I/O; `platform` is the only OS-conditional module; `companion` imports neither `core` nor `store`; no DAG violation |
| **contract drift** | 1 OS | regenerated code matches committed code |
| **prompt provenance** | 1 OS | no launch-bound string literal outside `invocation` |
| **vocabulary** | 1 OS | retired terms absent |

The four bolded jobs are cheap greps and structural checks. They are what turns this document's rules into facts. A rule without one of these is a wish.

## What agents may not do

- Commit a contract or schema change.
- Add a durable field without an inventory line.
- Introduce an OS conditional outside `platform`.
- Add a second composition path for prompts, or a resolver/facade layer over the existing one.
- Reintroduce retired vocabulary under a synonym.
- Widen a module's dependency set.
- Persist a projection.

Each of these has a CI check. That is deliberate: agents violate conventions constantly and cannot violate a failing build.

## Using the current product as an oracle

The existing product is a **behavioral reference, never a runtime dependency**.

- Capture the ~10 flows that actually matter as written scenarios, plus a corpus of real agent session logs, under `/oracle/`.
- Validate the new status derivation by replaying that corpus through both implementations and diffing.
- Do **not** treat the old code as a specification to be read exhaustively. Much of its behaviour is accidental, and reading it as spec re-imports the accidental complexity through the back door.

The specific knowledge worth harvesting rather than reinventing: agent session-log scanning, hook ingest, the status reducer, and prompt composition. Those encode months of empirical discovery about how the CLI agents actually behave. Translate them as test-first pure units in `domain` and `agents`.
