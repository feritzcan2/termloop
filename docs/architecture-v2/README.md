# Architecture packet — rewrite (v2)

Draft for architecture review. Design only; no implementation guidance below the module boundary.

| Doc | Contents |
|---|---|
| [00-OVERVIEW](00-OVERVIEW.md) | product shape, settled decisions, non-goals, glossary + retired vocabulary |
| [01-DOMAIN](01-DOMAIN.md) | entities, projections, lifecycles, cleanup gates, 10 domain invariants |
| [02-MODULES](02-MODULES.md) | 12 modules + clients, per-module contracts, strict dependency DAG |
| [03-CROSS-CUTTING](03-CROSS-CUTTING.md) | the 10 rules that span modules, each with a mechanical check |
| [04-PROTOCOL](04-PROTOCOL.md) | control/data plane, method surface, versioning, reattach |
| [05-PERSISTENCE](05-PERSISTENCE.md) | event-model decision, durable inventory, telemetry-vs-history test |
| [06-SKELETON](06-SKELETON.md) | build order S0–S7, risk-ordered, with exit criteria |
| [07-AGENT-WORKFLOW](07-AGENT-WORKFLOW.md) | ownership, contract gate, slices, definition of done, CI matrix |
| [08-REPO-LAYOUT](08-REPO-LAYOUT.md) | directory shape; which stack decisions stay open |
| [09-OPEN-DECISIONS](09-OPEN-DECISIONS.md) | contradictions and unsettled calls — **read this one first if short on time** |

## The three things worth arguing about

1. **[09](09-OPEN-DECISIONS.md) #3** — the Companion is meant to know outcomes, but nothing in the model records one. Largest open question in the design.
2. **[09](09-OPEN-DECISIONS.md) #16** — one VT engine for both daemon checkpoints and renderer display, coupled to the core-language choice. Highest technical risk; blocks skeleton S2.
3. **[09](09-OPEN-DECISIONS.md), standing position** — concurrency without a recovery path is silent data loss. Safety Snapshots are still "explore", not "commit".

## Reviewing this packet

Every rule in [03](03-CROSS-CUTTING.md) has a named mechanical check, and every module in [02](02-MODULES.md) has numbered invariants. If a rule you care about has no check, that is the bug — say so.
