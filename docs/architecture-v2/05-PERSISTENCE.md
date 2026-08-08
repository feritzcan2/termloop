# 05 — Persistence, internal event model, telemetry vs history

## Decision: current-state persistence + transient domain events

**Rejected: persisted event sourcing.** Adopted: a durable current-state store, with transient in-process events emitted after commit, plus one bounded durable journal for crash recovery.

### Why not event sourcing

1. **It manufactures the artifact the product rejects.** A persisted event log *is* a durable per-entity timeline. Once it exists, someone will surface it — and it fails the disposability test below by construction. Rejecting Task history at the product level while building an event log underneath is a contradiction with a delayed fuse.
2. **The domain is tiny.** A Task has two states. Event sourcing earns its cost in complex temporal domains with audit obligations. Neither applies.
3. **Replay is worthless here, because the authoritative facts live outside the store.** Git owns branches and commits. The filesystem owns checkouts. Live processes own sessions. A replayed log would still require full reconciliation against reality on every boot — so you would pay for event sourcing *and* still need the reconciler.
4. **Agent-authored code quality.** Coding agents write correct current-state persistence far more reliably than correct event upcasting and version migration.

### Adopt three event-sourcing habits without the machinery

- **Named commands, not setters.** One command = one intent = one transaction.
- **Post-commit transient events** are the only way another module learns of a change. This preserves the projection and fan-out benefits that make event sourcing attractive.
- **Versioned durable schema** with a forward-only migration path.

### The one durable append-only exception: the recovery journal

Atomic Task creation spans the filesystem (worktree provisioning) and the store (Task record). No single transaction covers both. Without a journal, an interrupted creation leaves an orphan directory, a partial Task, or both.

The journal is a short write-ahead record, **truncated on clean shutdown**, that lets the next boot either complete or roll back an interrupted atomic operation.

It is not history: bounded, invisible, disposable in the sense that losing it costs recovery ability rather than user information. It is the price of the atomic-creation decision, and worth confirming as acceptable — [09-OPEN-DECISIONS](09-OPEN-DECISIONS.md) #5.

---

## Durable inventory

Every durable field the system may hold. **A new durable field with no line here fails review.** This table is the mechanism that keeps the model small.

| Owner | State | Scope | Notes |
|---|---|---|---|
| `store` | Project record | machine | id, name, folderPath, settings |
| `store` | Task record | per-project | id, title, brief, rank, worktree{path,branch}, status, ownsWorktree, timestamps |
| `store` | Layout tree | per-project | pane tree referencing sessionIds |
| `store` | Session `resumeRef` | per-project | **single slot** per session — never a list |
| `store` | Schema version | both | forward-only migration |
| `store` | Recovery journal | machine | bounded, truncated on clean shutdown |
| `providers` | IssueLink sidecar | per-project | taskId, provider, ref, authority |
| `invocation` | Template catalog | user + project | on-disk, user-visible and editable by design |
| `agents` | Agent catalog config | user | capability overrides only |
| `observability` | Safety Snapshot refs | per-repo | hidden ref namespace, never pushed |

Deliberately **not** durable: presence, checkout health, PR data, Active Agents, provisioning progress, agent status, scrollback, file-activity rings, writer counts, anything shaped like "what happened over time."

---

## Telemetry vs history: the test

Bounded operational telemetry is legitimate if **all five** hold:

1. **Bounded** by size or TTL. Never grows with project age.
2. **Not a product surface.** A debug view at most.
3. **No domain decision reads it.**
4. **Deleting it loses nothing a user would miss.**
5. **Not shaped** to answer *"what happened on Task X over time."*

Fail any one and it is history, which the product rejects.

### Classified

| Item | Verdict | Reason |
|---|---|---|
| PTY ring buffer + VT checkpoints | ✅ telemetry | bounded, in-memory, required for reattach |
| Session `resumeRef` — **single slot** | ✅ runtime state | latest-pointer, not a timeline |
| A *list* of past `resumeRef`s per Task | ❌ history | fails (1) and (5) |
| File-activity ring per worktree | ✅ telemetry | bounded, in-memory, short TTL |
| Bounded debug logs | ✅ telemetry | bounded, not a product surface |
| Safety Snapshot refs | ✅ recovery | bounded by retention policy; needs real gc |
| Per-Task list of past sessions with outcomes | ❌ history | the rejected feature |

> **The line to remember: latest-pointer yes, list no.** This is the boundary an implementing agent will cross first, and the one to check in every review.

### Retention numbers must be literal

History will not arrive as a feature request. It will accrete out of the file-activity ring and the snapshot refs because nobody wrote a bound. Discipline does not hold that line; a number does.

Fill these in before scaffolding — they are deliberately left blank rather than invented here:

| Bound | Value | Owner |
|---|---|---|
| Ring buffer bytes per session | _TBD_ | `terminal` |
| VT checkpoints retained per session | _TBD_ | `terminal` |
| File-activity entries per worktree | _TBD_ | `observability` |
| File-activity entry TTL | _TBD_ | `observability` |
| Safety Snapshots retained per branch | _TBD_ | `observability` |
| Safety Snapshot debounce interval | _TBD_ | `observability` |
| Debug log bytes retained | _TBD_ | `observability` |

`gc` on cleanup must remove that worktree's snapshot refs, or git objects accumulate indefinitely — the one place where "bounded" needs an active mechanism rather than a ring.

---

## What deleting things must cost

A useful review question for any new state: *what breaks if we delete this?*

| Deleted | Cost |
|---|---|
| Any projection cache | latency only |
| All file-activity rings | recent collision attribution |
| All Safety Snapshots | ability to recover a clobber |
| All ring buffers / checkpoints | reattach shows a fresh screen instead of prior content |
| Recovery journal | ability to finish or roll back one interrupted creation |
| The store | actual user data — this is the only entry where the answer is "real loss" |

If a future addition would add a second row to that last category, it is a domain change and a human decision.
