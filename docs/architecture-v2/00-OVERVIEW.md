# 00 — Overview

Status: **draft for architecture review**. Not implementation guidance. No code decisions below the module boundary.

## What we are building

A cross-platform, terminal-first workspace for running many real terminals and many CLI coding agents against one project, with a project-aware helper alongside them.

The terminal is a **primary product surface**, not an escape hatch. Everything else in the design exists to make many concurrent terminals and agents comfortable to operate.

## Shape

A long-lived **daemon** owns all durable state and every PTY. The desktop UI, the CLI, and any future mobile client are **thin clients** of one versioned protocol. Agent sessions outlive the UI process; the UI can be killed and reattached without disturbing running work.

```
        ┌──────────── clients (thin) ────────────┐
        │  desktop        cli        mobile      │
        └───────────────────┬────────────────────┘
                     one versioned contract
                 control plane  +  data plane
        ┌───────────────────┴────────────────────┐
        │              daemon                     │
        │  core · store · terminal · invocation   │
        │  agents · gitio · providers · platform  │
        └─────────────────────────────────────────┘
```

## Settled product decisions this packet encodes

- Terminal-first. Many terminals and CLI agents are the primary surface.
- No `Workspace` concept — in the UI or the domain.
- No `Run` / `Attempt` / per-Task session history.
- `Project` has **Tasks**, **Sessions**, one **Project Companion**, and **UI Layout**.
- A **Task** is created atomically with exactly one non-optional worktree binding and branch. Provisioning failure leaves no durable Task.
- Task status is deliberately `open | closed`.
- Multiple simultaneous write-capable agents in one Task/worktree are **allowed**. No leases, launch gates, file locks, or forced confirmations.
- **Active Agents** is a derived projection over live agent Sessions, and remains a permanent sidebar section.
- **Task presence** is derived: a Session's stable `launchCwd` falling under `Task.worktree.path`.
- **Close** has zero filesystem effect. **Cleanup** is explicit and separate, removes the checkout, and retains the closed Task record. **Delete Task** is a third explicit action.
- No persisted per-Task session timeline. Bounded operational telemetry and recovery state are permitted when disposable.
- Concurrent-writer recovery is explored as bounded local **Safety Snapshots** (hidden git refs or equivalent) — non-blocking, never pushed.
- **PR data is a projection**: Task branch → configured remote → provider adapter → matching PR(s). Not a persisted link by default.
- Issue links (Jira/GitHub/GitLab) are **optional integration sidecars** keyed by Task id. Jira is not foundational.
- All prompts reaching agents are traceable to visible, editable templates. No inline hidden prompts.
- The current product is a **behavioral oracle**, never a runtime dependency.

## Explicit non-goals for v1

Not "never" — just not in scope for the first working system, and deliberately absent from the module set until decided:

- Dev-server previews · browser panel · MCP agent-to-agent handoffs · Tasks board UI beyond a list · mobile client · remote/SSH sessions.

These are tracked in [09-OPEN-DECISIONS](09-OPEN-DECISIONS.md) as unsettled scope, not designed away. Where they would attach is noted in [02-MODULES](02-MODULES.md).

## Glossary — and retired vocabulary

| Term | Meaning |
|---|---|
| **Project** | A folder plus its settings. The top-level container. |
| **Task** | Durable unit of worktree-backed work. Exactly one worktree binding + branch. `open \| closed`. |
| **Session** | One PTY. Either a plain terminal or a running CLI agent. Runtime, not history. |
| **Active Agents** | Projection over live agent Sessions. |
| **Presence** | Projection: which Sessions are attached to a Task, and how many can write. |
| **Safety Snapshot** | Bounded local recovery commit on a hidden ref. Never pushed. |
| **Companion** | The one project-aware helper. Reads projections, emits proposals, writes nothing. |
| **Binding** vs **existence** | A Task's worktree *binding* is durable data. Whether the *directory* exists is observed health. |

**Retired — do not reintroduce under any name:**

`Workspace` · `Run` · `TaskRun` · `Attempt` · `AgentRun` · task history / execution timeline · backlog Task without a checkout · write lease.

If a design needs one of these, it is a contract change and a human decision, not an implementation detail.

## Reading order

1. [01-DOMAIN](01-DOMAIN.md) — the model and its invariants
2. [02-MODULES](02-MODULES.md) — module set, per-module contracts, dependency DAG
3. [03-CROSS-CUTTING](03-CROSS-CUTTING.md) — the ten rules that span modules
4. [04-PROTOCOL](04-PROTOCOL.md) — control and data plane, schema ownership
5. [05-PERSISTENCE](05-PERSISTENCE.md) — durable inventory, telemetry-vs-history test
6. [06-SKELETON](06-SKELETON.md) — build order and exit criteria
7. [07-AGENT-WORKFLOW](07-AGENT-WORKFLOW.md) — how coding agents work in this repo
8. [08-REPO-LAYOUT](08-REPO-LAYOUT.md) — directory shape, stack-open markers
9. [09-OPEN-DECISIONS](09-OPEN-DECISIONS.md) — contradictions and unsettled calls
