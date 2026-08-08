# 09 — Contradictions and open decisions

Nothing here is decided in this packet. Items marked **contradiction** are places where two settled decisions do not compose and something must give. Items marked **open** are gaps. Each names who must decide.

Where the architecture had to proceed anyway, the packet states an assumption explicitly and flags it here rather than resolving it quietly.

---

## Contradictions in the settled decisions

### 1. Cleanup keeps the Task, so "binding present / directory absent" now means two different things — contradiction · product

Cleanup removes the checkout and retains the Task. A user deleting the checkout by hand produces the **identical** observable state. Both read as checkout health `missingPath`.

The Companion — and the user — need to distinguish *intentionally cleaned up* from *broken*. Resolving it needs one durable bit (e.g. `checkoutRemovedAt`, or a `cleanedUp` flag).

One flag is not history; it is current state. But it is product state, so it is your call, not ours. **Alternative:** decide the two cases need not be distinguished, and accept that a broken checkout looks like a tidy one.

### 2. "Delete Task" versus "Cleanup" ordering is undefined — contradiction · product

Three actions are settled, but their composition is not:

- Does Delete require Cleanup first, or does Delete also remove the checkout?
- Is Delete available on an **open** Task with a live checkout?
- If Delete removes a checkout, does it run the same safety gates? (It must, or Delete becomes the unsafe back door around every gate in [01-DOMAIN](01-DOMAIN.md).)

This packet assumes **Delete runs the same gates as Cleanup when a checkout is present.** Confirm or override.

### 3. The Companion must know outcomes, but nothing records an outcome — contradiction · product · **the sharpest one**

Settled: the Companion should know open/closed tasks, decisions, and outcomes. Also settled: status is only `open | closed`, there is no history, and no project decision log.

A closed Task therefore carries no outcome. Nothing in the model distinguishes *merged and shipped* from *abandoned* from *superseded by another task*.

Three ways out, all product decisions:

1. **Derive at read time** from git and the PR projection — consistent with the projection discipline, but after Cleanup removes the checkout, local git evidence may be gone, and the PR projection needs a network and a live remote.
2. **One durable outcome field** on Task (e.g. `merged | abandoned | superseded`). Small, current-state, not a timeline — but it is new product state.
3. **Accept the Companion cannot know outcomes**, only which tasks are open and closed.

The packet does **not** assume any of these. This is the largest open question in the design, because it is the Companion's core value proposition.

### 4. Companion runtime identity is undecided, and it changes the architecture — contradiction · product + technical

Is the Project Companion:

- **(a)** an agent CLI session — i.e. just a `Session` with special flags, appearing in Active Agents, prompts flowing through `invocation`; or
- **(b)** a separate in-process LLM client with its own transport?

This determines whether `companion` is a daemon module or a client, whether it consumes an agent seat, whether it survives UI restart, and whether prompt provenance applies to it in the same way.

The packet models **(b)** — a module that imports `contract` only — because that is what makes "cannot write" structural. If you choose (a), the no-write property needs a different enforcement mechanism, and the Companion becomes a `Session` in the domain.

### 5. Atomic creation requires a durable journal — contradiction · confirm only

"Atomic" spans the filesystem and the store. No single transaction covers both. Without a bounded write-ahead journal, an interrupted creation leaves an orphan directory, a partial Task, or both.

The packet assumes a **bounded, truncated-on-clean-shutdown recovery journal** is acceptable durable non-history state. Confirm.

### 6. Closed Tasks grow without bound — open · product

Cleanup retains the record and Delete is explicit, so the closed set grows for the life of the project. If the Companion reads all closed Tasks, its context grows with project age.

Is there archival, pruning, or a bound? Or is unbounded growth accepted?

### 7. Path repair versus "stable launchCwd" — contradiction · product + technical

Presence is derived from a Session's **stable** `launchCwd` under `Task.worktree.path`. But worktree paths can be repaired or relocated.

When a path is repaired, either:

- **(a)** the cohort's `launchCwd` values are rewritten — which means `launchCwd` is not stable after all; or
- **(b)** sessions keep their old `launchCwd` and silently detach from the Task.

Neither is obviously right. This is the cwd-cohort fan-out in a new guise, and it is the most likely route by which `Workspace` returns. Needs an explicit answer.

---

## Open product decisions

### 8. Is worktree adoption a feature? — determines whether `ownsWorktree` exists

If every Task provisions its own worktree atomically, `ownsWorktree` can never be `false` and should be deleted — which meaningfully simplifies cleanup safety.

If "make a Task from this existing checkout" is a wanted feature, `ownsWorktree` stays and gate 1 in [01-DOMAIN](01-DOMAIN.md) stays load-bearing.

The packet keeps the field, because deleting it is irreversible in a way that keeping it is not. Decide before scaffolding.

### 9. Branch rebinding policy — asked previously, still open

With no history, there is no provenance fallback for a rebind.

Standing recommendation: **path is repairable; branch identity is fixed for the Task's lifetime.** Branch *rename* is the same identity. Pointing a Task at a *different* branch makes it a different Task. Without a rule, a rebind silently changes what a Task means and nothing records it.

### 10. Can a closed, cleaned-up Task be reopened with a recreated worktree?

Product behavior. Affects whether the binding must remain reprovisionable and whether the base commit needs recording.

### 11. PR projection edge cases

- No remote configured, or offline: degrade to "unknown", or hide the surface?
- Multiple PRs match one branch: how is multiplicity presented, and is there a primary?
- Rate limits and auth failure: silent, or surfaced?

### 12. Layout scope and sharing

Layout is listed under Project. Open: is it durable across restarts (packet assumes yes, owned by `store`), and is it **shared across simultaneously connected clients** or per-client? If mobile and desktop attach at once, do they share one layout?

### 13. Attribution asymmetry across agents

Claude exposes a pre-write tool hook; Codex does not. Either accept best-effort asymmetric attribution (cheap, recommended) or build a uniform filesystem-only mechanism (consistent quality, more work, coarser).

### 14. Unsettled scope — not designed away, just not designed

None of these appear in the settled decisions, and the packet deliberately does not invent modules for them. Attachment points are noted at the end of [02-MODULES](02-MODULES.md).

Dev-server previews · browser panel · MCP agent-to-agent handoffs · Tasks board beyond a list · mobile client · remote/SSH sessions · notifications.

Each needs an explicit in-or-out call before it influences the module set.

### 15. Migration from the current product's on-disk state — asked twice, still open

Shipped installs hold workspace-keyed task bindings and a metadata store on disk. Does the rewrite import that state, or start clean?

Both are defensible. "Start clean" is entirely reasonable for a rewrite. Discovering the answer late is not.

---

## Open technical decisions

### 16. VT engine, and whether one engine serves both daemon and renderer — highest technical risk

A VT state machine is needed in the daemon (for reattach checkpoints) and in the renderer (for display). Two implementations diverge, and divergence shows up as corrupted screens after a UI restart.

This decision is **coupled to the core-language choice** and should be made as one decision, not two. It blocks skeleton step S2.

### 17. Core language and frontend shell

Open. See [08-REPO-LAYOUT](08-REPO-LAYOUT.md). The module set, DAG, domain model, and rules are all stack-independent and can be agreed first.

### 18. Retention numbers

The table in [05-PERSISTENCE](05-PERSISTENCE.md) is deliberately blank. These must be literal values before scaffolding, because history accretes out of unbounded rings rather than arriving as a feature request.

---

## One standing position

Safety Snapshots are currently framed as something to **explore**. Restating the position from the prior round unchanged, because it is the one item where the architecture has an opinion that outranks convenience:

> Unconstrained concurrent write-capable agents in one checkout, **plus** no history, **plus** no recovery path, converts "an action the user was prevented from taking" into "silent, unrecoverable loss of the user's work." No warning UI repairs that after the fact.

Safety Snapshots block nothing, gate nothing, and are invisible until needed — so this is compatible with the concurrency decision rather than a challenge to it. But "explored" is not yet "committed," and the concurrency decision is only safe once it is.

Skeleton step S5 is written to fail if it is not.
