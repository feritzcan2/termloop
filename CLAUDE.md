# AgentInputs — Context

Truth owners, composer, transport adapter, and Quick Action authoring
contract for agent-invocation input assembly. Depth reference:
`termloop/docs/termloop/agent-inputs.md`.

## What lives here

| File | Role |
|---|---|
| `AgentInputTypes.swift` | `AgentInvocationSource`, `AgentModelOption`, `AgentInvocationRequest`, `AgentInvocationPlan`, `ProjectInstructionSnapshot` |
| `AgentCatalogStore.swift` | Terminal-agent identity + per-agent model validity |
| `AgentTemplateStore.swift` | Template catalog (builtin / user / project, FSEvents reload) |
| `ProjectInstructionStore.swift` | Abilities + bundled prompts + system-ability templates (skills deferred) |
| `AgentInvocationComposer.swift` | `compose(_:)` — semantic plan, single public entry |
| `AgentInvocationTransportAdapter.swift` | Semantic plan → argv / prefix / initial prompt |
| `AgentInputQueries.swift` | Pure selectors over a plan |
| `PreviewOverrides.swift` | D1(B) per-run preview override layer (mute / force-include) |
| `BridgePromptCatalog.swift` | Ask-agent presets + bridge helper prompt content |

Quick Action is now the default **authoring surface** for user-authored
create-agent flows. Sheet/popover entry points may collect intent or
small prompt edits, but they should hand off to Quick Action prefill for
the final user-visible launch review.

## Invariants (do not break)

1. **Transport-agnostic plan.** `AgentInvocationPlan.resolvedSystemInstructions`
   is one agent-agnostic string. No argv / tempfile / flag choice in the
   composer or plan. Delivery lives in the transport adapter only.
2. **Catalog has model authority.** Templates *suggest*; `AgentCatalogStore.
   resolveModel(_:for:)` decides. A `.opus` request against an agent that
   only supports `.default` must return `.default`.
3. **Disk/watcher truth.** `ProjectInstructionStore` reads abilities from
   disk per call. No in-memory cache. The old `AbilityInjector` cache-
   bypass workaround is now the design — not a comment.
4. **Preview ⇄ launch share the base plan.** Both read from
   `AgentInvocationPlan`. Preview is allowed to layer *local* per-run
   overrides (ability mutes, force-includes — D1(B) side channel); those
   do not flow into launch. Any disagreement on non-override fields is a
   composer bug — fix the composer, not the consumer.
5. **Nothing hidden ships.** If text or flags reach the agent, the user
   must be able to see that exact payload in Quick Action preview/raw or
   the socket preview endpoint. Authored text and delivered text are not
   the same thing; preview must surface the delivered form.
5. **No resolver/facade layer.** Stores own truth, composer composes,
   queries select, adapter delivers. If you feel like adding
   `AgentInputResolver` or `BridgePromptResolver`, stop.
6. **`AgentInvocationSource` is a typed enum.** Use `reasonTag: String?`
   for free-form classifier suffixes (e.g. `"quickAction.freePrompt"`).
   Don't stuff runtime intent into `reasonTag`.

## When adding code

- **New agent-capability bit** (model, flag, env): `AgentCatalogStore`. Not
  the template, not the composer.
- **New template field**: `AgentTemplate` + `AgentTemplateStore`. Composer
  reads through the store.
- **New instruction source** (abilities, bundled prompts, later skills):
  `ProjectInstructionStore`. Snapshot returns one merged view; composer
  joins it into `resolvedSystemInstructions`.
- **New agent-specific CLI quirk** (flag shape, tempfile, prefix):
  `AgentInvocationTransportAdapter` or the backing
  `AgentSystemPromptInjector`. Do not teach the composer about CLIs.
- **New caller wanting a plan**: build an `AgentInvocationRequest`, call
  `AgentInvocationComposer.compose(_:)`. Don't re-implement variable
  substitution or system-prompt stitching at the call site.
- **New user-authored create flow**: present Quick Action with a
  prefilled request. Do not add a second final-authoring UI unless the
  flow is explicitly no-prompt.
- **Pure UI slice of a plan**: `AgentInputQueries`.

## When NOT adding code here

- **Bridge runtime** (`WorkspaceBridgeStore`, `BridgeCoordinator`,
  `BridgeMessageExtractor`) is out of this folder. Only bridge **input**
  composition (presets, kickoff prompts, helper launch) lives here.
  `BridgeKickoffSheet.submit()` just links two existing workspaces and
  kicks off forwarding — that stays in bridge runtime.
- **Terminal-agent presentation state** lives under `Core/` per the
  `TerminalAgentActivityStore` architecture. Do not mix run-state with
  invocation-input.
- **Workspace lifecycle** lives in `AgentTerminals/TerminalAgentLifecycle`.
  Composer/adapter produce inputs; Lifecycle orchestrates the create/
  restore/fork ordering.

## Phase status

The legacy seam is gone. `AgentRunRequest` + `AgentInvocationRequest+
Legacy.swift` were deleted in `d1dea210`. QuickAction launch and
preview both flow through the composer, fresh-launch semantics are
preserved by the `resolvedUserSystemPrompt` vs joined
`resolvedSystemInstructions` split on the plan, and socket preview now
returns the same plan/transport delivery view that Quick Action raw
preview reads.

Phase 6 landed. `AgentTemplateStore` owns watching/reload, production
consumers read templates through the store, `AbilityInjector`
composition helpers are gone, and typed `modelOverride` persistence is
in place. Quick Action prefill unification for user-authored
create-agent flows has landed.

## Hard rules

- New files in this folder only for the 7 roles above. If your new file
  doesn't fit one of those, you're probably adding a resolver — don't.
- Composer is transport-agnostic. Never import `AgentSystemPromptInjector`
  from it (injector may reverse-import the composer's reporting constant;
  the dependency direction is composer ← injector only via the constant).
- Consumer migrations land one call-site per commit, not as sweeping
  rewrites. The seam exists so each can prove out independently.
- Native same-agent conversation fork now has explicit source cases:
  `.claudeNativeFork` and `.codexNativeFork`. Keep `.workspaceFork`
  reserved for context handoff/new-session semantics.
