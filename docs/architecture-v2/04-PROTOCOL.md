# 04 — Protocol

One versioned contract. Every client — desktop, CLI, mobile, tests, the Companion — speaks it. There is no privileged in-process back door for the desktop app.

## Two planes, one connection lifecycle

### Control plane

Typed request/response plus a subscribed event stream. Low rate.

Carries: project and task commands and queries, session lifecycle, projections, agent status events, proposal apply, integration operations.

### Data plane

Raw framed bytes, one logical stream per session. High rate, bursty.

Carries: terminal output, terminal input, resize.

**Rule.** Terminal bytes never traverse control-plane serialization. Input latency is not the risk — a keystroke over local IPC is invisible. The risk is output: JSON-encoding and re-parsing a verbose build log or a large `cat`.

## Method surface shape

Grouped by capability, mirroring the module set. Illustrative, not exhaustive — the authoritative list lives in `contract/schema/`.

```
project.*      list · current · create · rename · delete · switch
task.*         list · get · create · close · reopen · cleanup · delete · repairPath
session.*      list · open · attach · detach · close · resize
invocation.*   composePreview · launch
projection.*   activeAgents · presence · checkoutHealth · pullRequests · concurrency
integration.*  linkIssue · unlinkIssue · listLinks
companion.*    proposals · applyProposal
recovery.*     snapshots · restoreSnapshot
events.*       subscribe · unsubscribe
```

Two shape rules worth stating:

- `invocation.launch` accepts `templateRef + bindings`, never a free-form prompt body. This is the wire-level expression of prompt provenance.
- `projection.*` methods are strictly read-only and are the Companion's entire read surface.

## Versioning

- Every method and event carries a version. The connection negotiates once at handshake.
- Additive fields and new methods are **minor**; clients tolerate unknown fields.
- Removals and shape changes are **major**, require a migration note, and require regenerating every client.
- The daemon and clients may run different minor versions. A major mismatch is refused at handshake with a clear message rather than failing later in a confusing way.

## Auth and transport

- Local IPC (Unix domain socket / named pipe) for same-machine clients.
- Authenticated TCP for remote clients such as mobile, since phones cannot reach a Unix socket.
- Both transports share one dispatch path. A method must never be reachable on one transport only, because that is how two divergent surfaces are born.
- The desktop client authenticates like everyone else.

## Backpressure and failure

- A slow client is dropped rather than allowed to stall a session.
- Data-plane streams are individually flow-controlled; a stalled terminal viewer must not block another session's output.
- Session lifetime is independent of every connection. Disconnect never kills a PTY.

## Reattach

The single most demanding interaction in the protocol.

```
attach(sessionId)
  → VT checkpoint   (grid, cursor, modes, alt-screen state)
  → then raw bytes since that checkpoint
```

Never a replay from process start: it is slow and ANSI-state-dependent, and it produces wrong screens for anything using alternate-screen mode.

This is why a VT state machine exists in the daemon at all, and why the same engine should serve the renderer. Two engines diverge, and divergence appears as corrupted screens after a UI restart. See [09-OPEN-DECISIONS](09-OPEN-DECISIONS.md) #10.

## Schema ownership

`contract/schema/` is human-owned and branch-protected.

- Agents propose schema changes as documents in a review queue, never as commits.
- Generated code is checked in; CI regenerates and fails on drift.
- A schema change is the unit that makes a cross-module feature legal — see [07-AGENT-WORKFLOW](07-AGENT-WORKFLOW.md).
