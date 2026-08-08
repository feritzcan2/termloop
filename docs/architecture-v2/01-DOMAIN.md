# 01 — Domain model

Everything here lives in `domain/` as pure types and pure functions. No I/O, no async, no platform.

## Durable entities

```
Project { id, name, folderPath, settings }
   │
   ├─ Task    { id, projectId, title, brief?, rank,
   │            worktree: { path, branch },     ← non-optional, set at creation
   │            status: open | closed,
   │            ownsWorktree,                   ← see 09, may be droppable
   │            createdAt, updatedAt }
   │
   ├─ Layout  { pane tree → sessionId }         ← references Sessions; never owns them
   │
   └─ IssueLink { taskId, provider, ref, authority }   ← owned by providers/, sidecar
```

## Runtime entities

```
Session { id, projectId, launchCwd, kind: terminal | agent,
          agentId?, permissionMode?, model?, resumeRef?, startedAt }
```

A Session is **runtime state**. It is not appended to any Task. Its only durable artifact is a **single-slot** `resumeRef` for resuming an agent conversation. Single slot, never a list — that distinction is the boundary between recovery state and history ([05-PERSISTENCE](05-PERSISTENCE.md)).

## Projections — derived, never stored as truth

| Projection | Derived from | Notes |
|---|---|---|
| **Active Agents** | live Sessions where `kind == agent` | permanent sidebar section, zero durable state |
| **Task presence** | Sessions whose `launchCwd` is under `Task.worktree.path` | also yields write-capable count |
| **Checkout health** | git observation of `worktree.path` | healthy / branchDrift / locked / prunable / missingPath / missingRegistration |
| **Pull requests** | `Task.worktree.branch` → configured remote → provider adapter | cached by `(remoteIdentity, branch)`, TTL'd, **not** a Task field |
| **Concurrency signal** | presence + file-activity ring | "2 writers attached", collision notices |

Deleting every projection cache must cost only latency. If deleting a cache loses information, it was truth in the wrong place.

## The binding/existence distinction

This is the load-bearing idea that keeps `Task.worktree` non-optional.

> A Task is **created with** exactly one worktree binding. It is not guaranteed that the **directory exists**.

- `worktree: { path, branch }` — durable, non-optional, set atomically at creation.
- Directory existence — **observed**, expressed as checkout health, never persisted as Task state.

Consequences:
- Cleanup removes the checkout and keeps the Task. Binding stays. Health becomes `missingPath`.
- A user deleting the checkout by hand produces the same health state without any Task mutation.
- There is no nullable worktree field, no `0..1`, and no "backlog Task" representation.

Open: after cleanup, "binding present / directory absent" is indistinguishable from a broken or externally-deleted checkout. See [09-OPEN-DECISIONS](09-OPEN-DECISIONS.md) #1.

## Task lifecycle

```
(none) ──create(title, branch, base)──▶  ATOMIC { provision worktree ; write Task }
                                            │
                                            ├─ failure ⇒ no Task, no orphan directory,
                                            │            error surfaced to the caller
                                            ▼
                                       open ⇄ closed        ← status only, ZERO filesystem effect
                                            │
                                            ├──cleanup (explicit)──▶ closed, checkout removed,
                                            │                        Task record retained
                                            │
                                            └──delete (explicit)───▶ (none)
```

Three separate user actions, three separate commands, no implicit coupling:

| Action | Filesystem | Task record | Branch |
|---|---|---|---|
| **Close** | untouched | retained, `closed` | untouched |
| **Cleanup** | checkout removed | retained | untouched unless separately opted in |
| **Delete** | (requires cleanup first, or cleans as part of it — see 09 #2) | removed | untouched unless separately opted in |

`create` spans the filesystem *and* the store, which no single transaction covers. Atomicity therefore requires a bounded crash-recovery journal — see [05-PERSISTENCE](05-PERSISTENCE.md).

Cleanup must be available on **open** Tasks too. People abandon work; do not couple cleanup to `closed`.

## Cleanup gates

`core` refuses cleanup unless all pass. Every gate is a git or filesystem observation, not stored state:

1. `ownsWorktree == false` ⇒ **unconditional refusal** to remove the directory. Adopted checkouts belong to the user. This is a refusal, not a confirmation dialog. Only the Task-side detach proceeds.
2. Working tree clean.
3. No untracked or ignored files that would be destroyed. This — not dirty tracked files — is the real data-loss risk.
4. No commits unpushed relative to upstream.
5. No divergence from the attach-time baseline head (a clean tree can still have diverged).
6. No live attached Session.

Branch deletion is a **separate opt-in**, never bundled with checkout removal. Irreversibility lives there.

## Status is two states, on purpose

`open | closed`. Nothing else durable.

Atomic creation is what makes this sufficient: provisioning either succeeds (Task exists, checkout exists) or fails (no Task). There is no durable `pending` and no durable `failed` — those state spaces do not exist in this model. Provisioning progress is transient and belongs to the in-flight command, not to the Task.

Everything a board would want — "blocked", "needs review", "provisioning" — is either derived at read time or is not modelled. In particular:

> **Blocked is derived, never stored.** A stored flag goes stale, and the Companion then reports a confident falsehood.

## Concurrent writers

Multiple write-capable agent Sessions may attach to one Task/worktree. The domain models this as a **fact to observe**, never a condition to prevent:

- `write-capable` is a property of the Session's permission mode. This makes permission mode a **domain concept**, not a launch flag: the core must be able to classify a mode as write-capable to count writers.
- Presence projection exposes the count. Nothing gates on it.
- Recovery is Safety Snapshots ([03-CROSS-CUTTING](03-CROSS-CUTTING.md) rule 9).

## Invariants

Stated so they can be tested, not just read.

| # | Invariant | Enforced by |
|---|---|---|
| D1 | A durable Task always has a non-optional `worktree {path, branch}` | type system |
| D2 | Task creation is all-or-nothing across filesystem + store | recovery journal + `core` |
| D3 | Task status ∈ `{open, closed}`; no other durable status exists | type system |
| D4 | Close performs zero filesystem operations | `core` command handler; conformance test |
| D5 | `ownsWorktree == false` ⇒ core never removes the directory | `core`; conformance test |
| D6 | No durable list of Sessions is attached to any Task | persistence inventory review + CI |
| D7 | Presence is computed from `launchCwd`, never stored on the Task | `domain` pure function |
| D8 | PR data is never a durable Task field | persistence inventory review |
| D9 | Every projection cache is disposable without information loss | conformance test: wipe cache, re-derive, compare |
| D10 | Nothing blocks or gates on writer count | absence of any such code path; review checklist |

## What Layout may and may not do

Layout is a pane tree whose leaves reference `sessionId`. It **references** Sessions; it never owns them.

If Layout ever owns Session lifetime, `Workspace` has returned under a new name. That is the single most likely regression in this design — see [09-OPEN-DECISIONS](09-OPEN-DECISIONS.md) #13 for the related path-repair question.
