# 03 — Cross-cutting rules

Ten rules that span modules. Each has an owner and a mechanical check. A rule with no check is a wish.

---

## 1. Single writer

Every durable mutation enters through a **named command** on `store`, issued by `core`. No other module writes durable state.

- Commands express intent (`closeTask`), never field assignment (`setStatus`).
- One command = one intent = one transaction.
- `store`'s write API is visible only to `core` — module visibility, not convention.
- Projections and caches are read-only by construction.

**Check.** CI: no module other than `core` references `store`'s write surface. Conformance: concurrent commands against one Task serialize and leave a consistent result.

**Why.** The current product's task-mutation single-writer rule is one of its few invariants that held up. Generalize it rather than reinventing it.

---

## 2. Persistence access

Only `store` opens a file holding domain truth.

- Per-project durable state lives under `<project>/.termloop/`. Machine-scoped state lives in one OS-appropriate app directory (resolved by `platform`).
- One format, one writer, atomic rename plus durability barrier.
- No scattered key-value settings store. The current product's ~385 `UserDefaults` call sites and ~20 JSON files are the specific outcome this rule prevents.
- Every durable field appears in the [05-PERSISTENCE](05-PERSISTENCE.md) inventory. No inventory line, no field.

**Check.** CI: filesystem-write APIs are not referenced outside `store`, `platform`, `observability`, and `gitio`. Review gate: a diff adding a durable field must also touch the inventory.

---

## 3. Protocol and schema ownership

`contract/` is human-owned and gated.

- Coding agents may propose a schema diff **as a document**. They may not commit one.
- Generated code is checked in *and* regenerated in CI; drift fails the build.
- Additive changes are minor. Removals and shape changes are major, and carry a written migration note.
- Every cross-process shape lives here. No side-channel JSON blobs, no untyped parameter dictionaries.

**Check.** CI regeneration diff. Branch protection on `contract/schema/`.

**Why.** The current wire protocol dispatches untyped dictionaries through a large string switch. That is workable for humans who remember the shapes; it is not workable for parallel agents, because nothing stops an agent from quietly changing what a field means.

---

## 4. PTY control plane / data plane split

| | Control plane | Data plane |
|---|---|---|
| Carries | commands, queries, events | terminal bytes, resize |
| Encoding | typed, from `contract` | raw framed bytes |
| Rate | low | unbounded bursts |
| Owner | `server` over `core` | `server` over `terminal` |

- Terminal output is **never** JSON-encoded or base64-encoded. Input latency is not the risk; output encoding is.
- One stream per session, or a binary multiplex with a minimal session header. Backpressure-aware.
- Resize travels on the data plane because it is ordering-coupled to the byte stream.
- Reattach is served from **VT checkpoint + bytes-since**, never a replay from process start.

**Check.** Conformance: flood a session with high-volume output and assert no control-plane message is delayed beyond budget. Skeleton step S1 measures keystroke-to-glyph against a written number.

---

## 5. Prompt provenance

A launch payload can be produced only by `invocation.compose()`.

- `core` **rejects** any launch request carrying free-form text not resolvable to `templateRef + bindings`.
- Preview and launch read the same plan from the same call.
- **Preview shows the delivered form, not the authored form.** Authored text and delivered text are not the same artifact; the promise is about what actually reaches the agent.
- Companion-initiated and integration-initiated launches obey the identical rule.

**Check.** CI: no string literal reaches a launch call site outside `invocation`. Conformance: a launch request with an untraceable prompt body is rejected; preview output is byte-identical to what the transport delivers.

**Why.** This is a product promise, and in the current product it is a documented rule. A coding agent will inline a prompt the first time it is convenient. Only a boundary plus a check survives that.

---

## 6. Platform adapters

`platform/` is the only module with OS conditionals. Everything else is platform-free.

- A domain rule that needs a platform fact receives it as **data**, never by querying the OS.
- An abstraction that cannot be expressed on all three targets does not belong in `platform`; the caller adapts.
- No platform-specific type appears in a public signature.

**Check.** CI grep for per-OS compilation branches outside `platform/`. This job runs on every commit and is the cheapest structural guard in the repo.

---

## 7. Projections and caching

- Projections are **pure functions from snapshots**, defined in `domain`, assembled by `core`.
- Caches are keyed, TTL'd, and disposable. Deleting any cache costs latency and nothing else.
- Never persist a projection as truth.
- PR data is a cache keyed by `(remoteIdentity, branch)` — not a Task field.
- Active Agents, presence, checkout health, and concurrency signals are all derived at read time.

**Check.** Conformance: wipe every cache, re-derive, and assert the result is identical. Any difference means truth leaked into a cache.

---

## 8. Cleanup safety

Gated in `core`, per [01-DOMAIN](01-DOMAIN.md):

1. `ownsWorktree == false` ⇒ **unconditional refusal** to remove the directory. Not a dialog. Adopted checkouts belong to the user.
2. Untracked and ignored files block removal — this, not dirty tracked files, is the real data-loss path.
3. Unpushed commits block removal.
4. Divergence from the attach-time baseline blocks removal even when the tree is clean.
5. A live attached Session blocks removal.
6. Branch deletion is a **separate opt-in**, never bundled.

Close is filesystem-free. Cleanup retains the Task record. Delete is a third action. Cleanup is available on open Tasks.

**Check.** Conformance suite per gate, each asserting refusal. A test that an adopted checkout survives a forced cleanup attempt.

---

## 9. Concurrent-writer observability and recovery

Nothing blocks. Non-goals, written down so they do not creep back: **no launch gating, no file locking, no serialization of agent git, no forced confirmations, no "are you sure" on a second writer.**

**Tier 1 — visibility (pure projection).** Attached-session list per worktree with write-capable count; a "2 writers" indicator on the Task. Concurrency should never be a surprise; this alone removes most of the harm.

**Tier 2 — recovery (the load-bearing part).** Bounded **Safety Snapshots**: on a debounce, while ≥2 write-capable sessions are attached, capture the working tree via a **scratch index** into a commit on a hidden ref namespace. The user's index and `git status` are never touched. Never pushed. Bounded retention, gc on cleanup.

> This is the mechanism that makes the no-lease decision safe rather than lossy. With no lease, no history, and no snapshots, a clobber is silent and unrecoverable, and there is nothing to reconstruct from.

**Tier 3 — attribution and warnings.**
- File-activity ring per worktree: `(path, timestamp, sessionId?)`, bounded, in-memory.
- Primary attribution source: Claude's `PreToolUse` hook, which fires **before** the write and already flows end-to-end in the current product carrying tool name and target path.
- Fallback: filesystem watching. Attribution degrades gracefully — one write-capable session attached ⇒ attribute; multiple ⇒ unattributed.
- Collision notice when two sessions touch one file inside a window.
- HEAD-moved-under-you notice when one agent commits or rebases while another is mid-edit.
- `index.lock` contention notice. Report only — agents run git themselves and cannot be serialized from outside.

**Tier 4 — assistance.** The Companion may propose a division of labour or flag overlap. Proposal only, never enforcement.

**Check.** Conformance: simulate two writers clobbering one file; assert a snapshot exists from which the lost version is recoverable. Assert no code path returns "denied" based on writer count.

---

## 10. Companion authority

The Companion owns nothing in the domain.

- **Owns:** its transcript and proposal queue, typed as opinion, never read by a domain decision.
- **Observes:** tasks, presence, checkout health, PR projections, test data — through the same projections every client uses. No privileged read path.
- **Proposes:** every mutation is a visible, reviewable proposal. Applying it is an ordinary user command through the single writer.
- **Cannot write:** enforced by dependency direction — `companion` imports `contract` only.

Reading authoritative data is necessary but not sufficient. The Companion must be *structurally unable* to write, or its mistakes become durable truth.

**Check.** CI: `companion` has no import of `core` or `store`. Conformance: no protocol method mutates state on the Companion's behalf without an explicit apply command.
