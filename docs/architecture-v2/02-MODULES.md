# 02 — Modules and dependency DAG

Twelve modules plus clients. The test applied to each: *would two coding agents working in parallel collide here, and can this module's correctness be proven without standing up anything else?*

Three of these are candidates for merging if the count feels high — noted inline. Everything else earns its boundary.

## Dependency DAG

Strict. Arrows point at dependencies. No cycles, ever.

```
L0  contract                      (no deps — schema + generated types)
    domain                        (no deps — pure)
    platform                      (no deps — OS only)

L1  gitio       → platform
    providers   → platform                    (network; no domain types)
    agents      → domain, platform
    store       → domain, platform

L2  invocation  → domain, agents, platform
    terminal    → platform, <vt engine>
    observ.     → gitio, platform

L3  core        → domain, store, gitio, providers, agents,
                  invocation, terminal, observability, platform

L4  server      → contract, core, terminal
    companion   → contract                    ← NOT core, NOT store

L5  clients/*   → contract
```

### Direction rules that are not negotiable

- **Nothing depends on `server`.** It is the outermost daemon layer.
- **`companion` depends on `contract` only.** Its inability to write is *structural* — it has no import of `core` or `store`. This is the enforcement mechanism for Companion authority, not a documented promise.
- **`domain` depends on nothing.** Forever.
- **`platform`, `gitio`, `providers` know no domain types.** They take paths, refs, and remote identities.
- **`invocation` is the only module that may produce an agent launch payload.** `core` calls it; nothing else may.
- **`terminal` knows nothing about Tasks.** It knows sessions, PTYs, and bytes.
- **`clients` never import a daemon module.** Only `contract`.

Enforcement is a CI job, not review discipline — see [07-AGENT-WORKFLOW](07-AGENT-WORKFLOW.md).

---

## contract

**Responsibility.** The single versioned definition of everything crossing a process boundary: control-plane methods, event types, data-plane framing, error shapes. Plus generated client/server types for every language in use.

**Owned state.** None. Schema files and generated output only.

**Public surface.** Generated types. Nothing hand-written.

**Forbidden.** Any logic. Any dependency. Hand-edited generated files.

**Invariants.**
- C1 Schema is human-owned. A coding agent may propose a diff as a document; it may not commit one.
- C2 Generated code is checked in *and* regenerated in CI; a drift between them fails the build.
- C3 Every method and event is versioned. Additive changes are minor; removals and shape changes are major and require a migration note.

**Replaces.** The current product's untyped `[String: Any]` params dispatched through a ~36-case string switch. That pattern is the reason a parallel-agent build needs schema-first codegen: an agent cannot silently change a wire shape that is generated from a gated file.

---

## domain

**Responsibility.** Types, invariants, state transitions, and pure projection functions. The whole model from [01-DOMAIN](01-DOMAIN.md).

**Owned state.** None — it is pure. It defines the *shape* of state that `store` persists.

**Public surface.** Types; validation functions; transition functions (`close(task) -> Result<Task>`); projection functions (`presence(sessions, task) -> Presence`, `activeAgents(sessions) -> [AgentRow]`).

**Forbidden.** All I/O. All async. All platform APIs. Any dependency whatsoever.

**Invariants.**
- Dm1 Zero imports outside the standard library.
- Dm2 Every function is total and deterministic — same inputs, same output, no clock, no randomness, no environment. Clocks and ids are passed in.
- Dm3 Projection functions take snapshots and return view models. They never fetch.

**Why it is separate.** Coding agents write excellent pure functions and unreliable stateful coordinators. Every rule worth trusting goes here where it is trivially testable. The current product already proves this works — its agent presentation reducer is a pure snapshot→state function and is the most reviewable code in the tree.

---

## platform

**Responsibility.** The only module containing OS conditionals. PTY creation and resize, process spawn/signal/reap, filesystem watching, standard paths, service/daemon installation, single-instance locking.

**Owned state.** OS handles only.

**Public surface.** `Pty` (open/read/write/resize/close) · `ProcessHandle` (spawn/signal/wait) · `FsWatcher` · `Paths` · `ServiceControl`.

**Forbidden.** Any domain type. Any knowledge of Tasks, Sessions, agents, or git. Any policy.

**Invariants.**
- P1 The only module with per-OS compilation branches. Verified by CI grep.
- P2 Every abstraction is expressible on macOS, Windows (ConPTY), and Linux. If it is not, it does not belong here — the caller adapts instead.
- P3 No abstraction leaks a platform-specific type in its public signature.

**Highest-risk contents.** Windows process semantics — no `fork`, ConPTY handle lifetimes, different signal model, different shell and path conventions. This is why [06-SKELETON](06-SKELETON.md) puts three-OS process work at step S3 rather than at the end.

---

## gitio

**Responsibility.** Executing git and returning typed results. Worktree add/list/remove, status, refs, diff, commit plumbing (`write-tree` / `commit-tree` / `update-ref`).

**Owned state.** None durable. May hold short-lived result caches.

**Public surface.** Typed commands and queries over paths and refs. No Task or Session types anywhere.

**Forbidden.** Domain types. Policy decisions (whether a cleanup is *allowed* is `core`'s call; `gitio` only reports facts).

**Invariants.**
- G1 One canonical runner. No raw process spawning for git elsewhere.
- G2 Read commands suppress optional locks so presentation never contends with agent or user writes. Write commands do not.
- G3 Every invocation has a bounded timeout and drains its pipes.
- G4 Never blocks a UI or protocol-serving thread.

**Honest limit.** Agents shell out to git themselves. `gitio` can protect *our* reads from lock contention; it cannot serialize *their* writes. Concurrent `index.lock` contention between two agents is observable and reportable, not preventable. See [03-CROSS-CUTTING](03-CROSS-CUTTING.md) rule 9.

---

## providers

**Responsibility.** Outbound integrations. Remote identity parsing, git-host adapters for PR discovery, issue-tracker adapters, auth resolution, rate limiting.

**Owned state.** The `IssueLink` sidecar table (keyed by task id) and TTL'd caches keyed by remote identity or external ref.

**Public surface.** `discoverPullRequests(remoteIdentity, branch) -> [PullRequest]` · `IssueLink` CRUD · provider capability descriptors.

**Forbidden.** Writing to `store`. Any durable field on `Task`. Direct access to `core`. Provider-specific types in the generic reference shape.

**Invariants.**
- Pr1 PR data is a **cache**, never a Task field. Keyed by `(remoteIdentity, branch)`.
- Pr2 Issue links are a **sidecar keyed by task id**, never fields on `Task`.
- Pr3 Cached remote state (status label, remote title, last-sync time) lives in the provider cache. Deleting the whole cache must lose nothing but latency.
- Pr4 Every link declares a sync **authority** (`none | localWins | remoteWins`). Without a declared direction you get sync loops the first time both sides change. This is load-bearing, not decoration.
- Pr5 Mutations to Tasks, if a link's authority permits any, go through the ordinary command bus with a narrowly allowed command set. No privileged path.

**Why this shape.** The current product carries roughly 5,000 of ~8,800 lines in its Tasks domain as remote-sync machinery, plus four remote fields on the Task record. That is the accidental complexity this boundary exists to prevent. The existing remote-reference value type — provider, key, url, host, namespace, repository, number, with no provider-specific leakage — is already the right shape and should carry over.

---

## agents

**Responsibility.** What CLI agents are and what they are doing. Agent catalog (identity, capabilities, valid models, which permission modes are **write-capable**), hook ingest, agent session-log scanning, and the pure status reducer.

**Owned state.** Catalog (static/config). Live agent status (runtime). Bounded file-activity ring input.

**Public surface.** `catalog` queries · `isWriteCapable(agentId, permissionMode) -> Bool` · `ingestHook(payload)` · `status(snapshot) -> AgentDisplayState` (pure, lives in `domain`; `agents` supplies the snapshot).

**Forbidden.** Composing prompts (that is `invocation`). Knowing about Tasks. Writing durable domain state.

**Invariants.**
- A1 **The catalog has capability authority.** Templates *suggest* a model; the catalog *decides*. A request for a model an agent does not support resolves to that agent's default.
- A2 Write-capability of a permission mode is a catalog fact, because the presence projection depends on it.
- A3 Status derivation is a pure reducer over a snapshot. Sticky/observed inputs go in; a display state comes out. No I/O inside the reducer.
- A4 Hook ingest is best-effort and never blocks an agent. A hook failure degrades observability, never the agent.

**Carry-over worth preserving.** The existing hook plumbing already forwards Claude's `PreToolUse` payload — tool name and target file path — end to end, and currently uses it only as a liveness breadcrumb. That payload is the strongest available collision signal because it fires *before* the write lands. Extracting it is close to free. Codex has no equivalent tool hook, so attribution is asymmetric by construction — see [09-OPEN-DECISIONS](09-OPEN-DECISIONS.md) #9.

---

## invocation

**Responsibility.** Everything between "user intends to launch an agent" and "an exact payload is delivered". Template catalog (builtin / user / project), instruction sources, composition into a transport-agnostic plan, and per-agent delivery.

**Owned state.** Template catalog (on disk, watched). Per-run override layer.

**Public surface.** `compose(request, overrides) -> InvocationPlan` — **one** public entry · `deliver(plan, agentId) -> LaunchPayload` · pure selectors over a plan.

**Forbidden.** Knowledge of CLI argv shapes in the composer. Any second composition path. Any resolver/facade layer. Being called by anything other than `core`.

**Invariants.**
- I1 **Transport-agnostic plan.** Resolved instructions are one agent-agnostic string. No argv, tempfile, or flag choices in the composer or the plan. Delivery lives only in the transport adapter.
- I2 **Preview and launch share one composition path.** Both read the same plan produced by the same call, including run-scoped overrides. Any disagreement between them is a bug in the shared path, not in a consumer.
- I3 **Nothing hidden ships.** If text or a flag reaches an agent, the user can see that exact payload. Authored text and delivered text are not the same thing — **preview must surface the delivered form.**
- I4 Model authority belongs to `agents`, not to templates.
- I5 A launch payload can be produced **only** here. `core` rejects any launch request carrying free-form text not resolvable to `templateRef + bindings`.

**Why it is a module boundary rather than a rule.** "No hidden prompts" is a product promise. In the current product it lives as a documented rule, and documentation does not survive contact with a coding agent that finds inlining a prompt convenient. A module boundary plus a CI check does. This module's shape is deliberately modelled on the existing agent-input design, which already got this right — six roles, one composer entry, no facade.

---

## store

**Responsibility.** Durable state and the single writer. Owns every file that holds domain truth. Serializes writes, emits post-commit events.

**Owned state.** All of it. Projects, Tasks, Layout, single-slot `resumeRef`s, schema version, recovery journal.

**Public surface.** Named commands (`createTask`, `closeTask`, `cleanupTask`, `deleteTask`, …) · typed queries returning snapshots · a post-commit transient event stream.

**Forbidden.** Being written to by anything except `core`. Exposing mutable handles. Persisting projections. Setter-style APIs.

**Invariants.**
- S1 **Single writer.** Every durable mutation enters through a named command here. The write API is visible only to `core` — module visibility, not convention.
- S2 One command = one intent = one transaction. Atomic rename plus durability barrier.
- S3 Events are emitted **after** commit, and are the only way any other module learns of a change.
- S4 Durable state carries a schema version with a forward-only migration path.
- S5 Nothing derived is persisted. If a value can be computed, it is not stored.
- S6 The full durable inventory is enumerated in [05-PERSISTENCE](05-PERSISTENCE.md). A new durable field without a line there fails review.

**Anti-pattern this exists to prevent.** The current product spreads durable state across ~385 `UserDefaults` call sites and roughly twenty JSON files, with one metadata aggregate carrying ~25 fields across six unrelated concerns and publishing nine separate change-notification counters. One writer, one inventory, one format.

---

## terminal

**Responsibility.** PTY session supervision and the data plane. Spawn, attach, detach, resize, kill. Bounded raw ring buffer plus periodic VT checkpoints so a restarted client can resync without asking the shell to redraw.

**Owned state.** Live PTYs, per-session ring buffers, per-session VT checkpoints. All in memory, all bounded, none durable.

**Public surface.** `open(spec) -> sessionId` · `attach(sessionId) -> (checkpoint, byteStream)` · `write(sessionId, bytes)` · `resize` · `close`.

**Forbidden.** Any domain type. Any knowledge of Tasks. JSON-encoding terminal output. Persisting scrollback as durable state.

**Invariants.**
- T1 Session : PTY is 1:1, always.
- T2 PTYs are owned here and nowhere else. A client disconnecting never terminates a PTY.
- T3 Terminal output never travels as JSON or base64. Raw framed bytes only.
- T4 Reattach is served from **checkpoint + bytes-since**, never by replaying from process start.
- T5 Ring buffers and checkpoint counts are bounded by literal configured values.
- T6 Resize travels on the data plane, because it is ordering-coupled to the byte stream.

**Top technical risk in the whole design.** A VT state machine is needed *here* (for checkpoints) and in the *renderer* (for display). Two implementations will diverge, and divergence manifests as corrupted screens after a UI restart — the worst possible bug class for a terminal-first product. Strong preference: **one VT engine used in both places.** This is the main non-aesthetic argument for a stack where the same engine can compile into both the daemon and the frontend. Unresolved — [09-OPEN-DECISIONS](09-OPEN-DECISIONS.md) #10.

---

## observability

**Responsibility.** Bounded, disposable operational state, and the recovery mechanism for concurrent writers. File-activity rings, collision/HEAD-moved/lock-contention detection, Safety Snapshots, retention policy.

**Owned state.** In-memory bounded rings. Hidden git refs for snapshots. Bounded debug logs.

**Public surface.** `recordActivity(worktreePath, filePath, sessionId?)` · `activity(worktreePath) -> [Entry]` · `snapshot(worktreePath)` · `snapshots(worktreePath) -> [Ref]` · `restore(ref, into:)`.

**Forbidden.** Writing to `store`. Being read by any domain decision. Unbounded growth of anything. Surfacing as a product timeline.

**Invariants.**
- O1 Every structure here is bounded by a **literal configured number**, written down in [05-PERSISTENCE](05-PERSISTENCE.md).
- O2 Safety Snapshots use a scratch index, so the user's index and `git status` are never touched, and land on a hidden ref namespace.
- O3 Snapshots are **never pushed**. Ever.
- O4 Deleting everything this module owns costs recovery ability and debuggability — never correctness, and never information a user would miss.
- O5 Nothing here is queryable as "what happened on Task X over time."

**Why a module rather than a corner of `core`.** Because the telemetry-versus-history boundary needs an owner. Retention numbers in one place, and a single module to audit when someone asks whether history has crept back in. **Merge candidate** if the module count is a problem — but then the retention numbers still need one home.

---

## core

**Responsibility.** Command handlers and orchestration. Task lifecycle including atomic creation and the recovery journal, Session lifecycle, worktree provisioning and repair, cleanup gating, snapshot triggering, projection assembly.

**Owned state.** In-flight command state only. Everything durable belongs to `store`.

**Public surface.** One command entry point per user intent. Query entry points returning assembled projections.

**Forbidden.** Direct file writes for domain state. Producing a launch payload itself. Being imported by `domain`, `platform`, `gitio`, `providers`, `agents`, `invocation`, `terminal`, or `observability`.

**Invariants.**
- Co1 Atomic Task creation is journaled, so an interrupted creation leaves neither an orphan directory nor a partial Task.
- Co2 Every cleanup gate from [01-DOMAIN](01-DOMAIN.md) is checked here; `ownsWorktree == false` is an unconditional refusal.
- Co3 Worktree path repair is **one transactional command** that fans out to the whole cwd cohort. Implemented as a sequence of independently issued writes, `Workspace` returns.
- Co4 No command gates on writer count. Ever.
- Co5 Launch requests are rejected unless resolvable to `templateRef + bindings` via `invocation`.

**The cwd cohort.** Sessions each carry their own `launchCwd`. The set of sessions under a worktree path is an **index**, not a stored parent. That is what lets `Workspace` stay deleted. Co3 is the invariant protecting it.

---

## companion

**Responsibility.** The one project-aware helper. Reads projections; produces proposals. Writes nothing.

**Owned state.** Its own transcript and its own proposal queue — both explicitly typed as *opinion*, never as truth, and never read by a domain decision.

**Public surface.** Proposals (each a draft command plus rationale). Applying one is an ordinary user command through the normal single writer.

**Forbidden.** Importing `core` or `store`. Any durable domain mutation. Composing free-form prompts for agent launches.

**Invariants.**
- Cp1 **Structurally unable to write** — it imports `contract` only. Not a promise; a dependency fact.
- Cp2 Reads authoritative task/git/PR/test data through the same projections every client uses. Its chat is never treated as truth.
- Cp3 Companion-initiated agent launches are `templateRef + bindings`, subject to the same rejection rule as any other launch.
- Cp4 Nothing auto-applies. A proposal becomes a change only through an explicit user command.

**Precedent worth reusing.** The current product already implements suggestion → applier → decision-log for its context bank. That is the correct pattern; do not invent a second one.

**Unresolved and consequential.** Is the Companion an agent CLI session (i.e. just a `Session` with special flags), or a separate in-process LLM client? This determines whether it is a module or a client, and whether its prompts flow through `invocation`. See [09-OPEN-DECISIONS](09-OPEN-DECISIONS.md) #4.

---

## server

**Responsibility.** The daemon's outer edge. Transport (local IPC plus authenticated TCP), auth, control-plane dispatch, data-plane multiplexing, event fan-out, backpressure, protocol versioning.

**Owned state.** Connections, subscriptions, per-connection backpressure.

**Public surface.** The wire. Nothing in-process.

**Forbidden.** Any domain logic. Any decision. Bypassing `core` to reach `store`.

**Invariants.**
- Sv1 A pure dispatcher — parse, authorize, route, serialize. Zero policy.
- Sv2 Control and data planes are separate; terminal bytes never pass through control-plane serialization.
- Sv3 Every client is equal. The desktop app gets no privileged method that the CLI lacks.
- Sv4 A slow or dead client is dropped without affecting sessions or other clients.

---

## clients

`desktop` · `cli` · `mobile`.

**Responsibility.** Rendering and input. Terminal rendering, layout tree, task list, panels, prompt authoring surfaces.

**Owned state.** View state only. Layout *content* is durable and belongs to `store`; layout *presentation* is local.

**Forbidden.** Importing any daemon module. Holding domain truth. Owning a PTY. Composing prompts locally.

**Invariants.**
- Cl1 `contract` is the only import from the daemon side.
- Cl2 The UI is a fold over projections and events. It never derives truth independently.
- Cl3 Killing a client never disturbs a Session.

**Merge candidates** if module count is a concern: `observability` into `core`; `providers` split between `gitio` and a thin integrations module; `agents` into `invocation`. I would resist all three — each removes an enforcement point — but they are the honest candidates.

---

## Where deferred features would attach

Recorded so they are visibly deferred, not accidentally designed away:

| Deferred feature | Attachment point |
|---|---|
| Dev-server previews | new module at L2 depending on `platform`; a projection in `core` |
| Browser panel | client-side only; no daemon module |
| MCP agent-to-agent handoffs | `server` method surface + `invocation` for the prompt path |
| Tasks board | client-side; `rank` already exists in `domain` |
| Remote / SSH sessions | `platform` PTY abstraction gains a transport; `terminal` unchanged |
| Mobile | `clients/mobile` over the existing contract |
