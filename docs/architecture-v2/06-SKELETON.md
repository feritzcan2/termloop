# 06 — Walking skeleton and build order

Ordered by **risk, not by feature value**. The existential risks are terminal feel and reattach fidelity; they come first, before any domain work. If S1–S3 cannot be made to work, the rest of the design does not matter.

Each step ends with something demonstrable and a written exit criterion. No step is "done" because a module compiles.

---

## S0 — Contract, DAG enforcement, three-OS CI

**Proves** the structure is enforceable *before* any feature exists.

- `contract/` with one method (`ping`) and one event. Generated clients checked in.
- All twelve module directories exist, empty or near-empty, with declared dependencies.
- The **purity CI job** runs and passes: `domain` has no I/O imports, `platform` is the only module with OS conditionals, `companion` imports neither `core` nor `store`, no module violates the DAG.
- CI green on macOS, Windows, Linux.

**Exit:** a deliberately introduced DAG violation fails CI. That is the whole point of the step.

---

## S1 — PTY echo across the plane split

**Proves** terminal feel and the control/data plane separation. Highest risk, therefore first.

- Daemon spawns one shell in a PTY. One session. Raw framed data plane.
- One frontend window renders it. Typing works.
- **Write the keystroke-to-glyph budget down before building**, then measure against it.
- Flood the session with high-volume output and confirm the control plane is not delayed.

**Exit:** measured latency inside the written budget, on the real chosen stack. Not a prototype in a different technology.

---

## S2 — Reattach

**Proves** daemon-owned PTY survival and settles the VT-engine question.

- Kill the frontend. Reconnect. Correct screen from checkpoint + bytes-since.
- Repeat under three hostile conditions: mid-flood of high-volume output; inside a full-screen alternate-screen program; immediately after a resize.

**Exit:** all three reattach correctly, byte-for-byte comparable to an uninterrupted session. Any divergence here is the two-VT-engine problem surfacing, and must be resolved now rather than absorbed.

---

## S3 — Cross-platform process semantics

**Proves** the `platform` abstraction is real rather than macOS-shaped.

- S1 and S2 green on Windows (ConPTY) and Linux, in CI, not just locally.
- Spawn a **real CLI coding agent**, not a shell — including its own subprocess behaviour, signal handling, and clean termination.
- Verify shell resolution, path semantics, and environment propagation on each OS.

**Exit:** the same scenario script passes on all three targets. Any OS conditional that leaked outside `platform` is fixed, not exempted.

---

## S4 — Project and atomic Task creation

**Proves** atomicity, which is the part the "atomic" decision actually requires.

- Create a project. Create a Task: provision worktree + write Task record in one journaled operation.
- **Kill the daemon mid-creation**, at several injected points. On restart, assert: no orphan directory, no partial Task, and a clear outcome either way.
- Close a Task and assert zero filesystem operations occurred.

**Exit:** the kill-mid-creation test passes at every injection point. Close is provably filesystem-free.

---

## S5 — Multiple write-capable agents in one Task

**Proves** the concurrency decision is safe, and exercises the recovery mechanism.

- Launch two write-capable agents into one Task worktree. Nothing blocks, nothing prompts.
- Presence projection reports two writers.
- File-activity ring attributes edits: via `PreToolUse` for the agent that supports it, via filesystem watching for the one that does not.
- Collision notice fires when both touch one file.
- Deliberately clobber a file, then **recover the lost version from a Safety Snapshot.**
- Confirm snapshots never appear in `git status`, `git log`, or any push.

**Exit:** the clobber is recoverable. If it is not, the no-lease decision is unsafe as built.

---

## S6 — Projections

**Proves** the derivation discipline holds.

- Active Agents from live sessions. Presence from `launchCwd`. Checkout health from git. PR discovery from branch → remote → provider adapter.
- Wipe every cache; re-derive; assert identical results.
- Delete a checkout externally; assert health becomes `missingPath` with no Task mutation.

**Exit:** the cache-wipe equality test passes. Any difference means truth leaked into a cache.

---

## S7 — Prompt provenance

**Proves** the product promise is mechanized rather than documented.

- Launch an agent through `invocation` only.
- Preview shows the **delivered** payload, byte-identical to what the transport sends.
- A launch request with a free-form prompt body is **rejected** by `core`.
- The CI check catches a deliberately inlined prompt string added outside `invocation`.

**Exit:** all four hold, including the deliberate-violation test.

---

## Explicitly out of the skeleton

Tasks board UI · dev-server previews · browser panel · mobile client · layout persistence and splits · themes and settings UI · issue-tracker integrations · the Companion · remote/SSH sessions · notifications.

Worktree *provisioning* is in (S4) because atomicity is a risk. Worktree *ergonomics* are not.

---

## Sequencing rationale

The temptation is to build the domain first because it is pleasant and well understood, then discover in month four that reattach corrupts screens or that Windows process handling forces a redesign of `platform`. S1–S3 exist to make that discovery cheap.

A useful checkpoint after S3: **can one coding agent add a capability end-to-end — schema proposal, one module, conformance test — in a single loop without touching another agent's files?** If not, the module design is wrong, and no amount of feature progress repairs it.
