# Agent Inputs — Architecture Note

Status: Phases 1, 2, 3, 3.5, 4, 5, and 6 landed. Legacy adapter
removed (`AgentInvocationRequest+Legacy.swift` deleted in `d1dea210`),
QuickAction launch and preview both flow through the composer, socket
preview uses the same plan/transport seam, user-authored create-agent
flows route through Quick Action prefill, `AgentTemplateStore` owns
template watching/reload, and `AbilityInjector` no longer owns
composition helpers.

Editable-prompt UI contract: QuickAction (prompt / system prompt /
model / permission), AskToSheet (source + target prompts), AbilitiesPanel
(creator / refiner / template via `AbilityLaunchEditSheet`),
BridgeKickoffSheet (kickoff + role prompt), fork flows via Quick Action prefill,
NewWorkspaceWithWorktreeForm (initial + system prompt). Every user-
visible spawn path that carries a prompt now surfaces an editor.

## Ownership

| Concern | Owner |
|---|---|
| Terminal-agent identity, status keys, supported-model set | `AgentCatalogStore` |
| Template catalog (builtin / user / project, FSEvents reload) | `AgentTemplateStore` |
| Project abilities, bundled prompts, system-ability templates | `ProjectInstructionStore` |
| Skills (reference-only popover scanner) | `SkillCatalog` — out of scope per D3(B) |
| Caller intent → semantic launch payload | `AgentInvocationComposer.compose(_:)` |
| Pure UI selectors over a plan | `AgentInputQueries` |
| Per-agent CLI delivery (claude flag / codex tempfile / others-prefix) | `AgentInvocationTransportAdapter` |
| Bridge / ask-agent presets and prompt content | `BridgePromptCatalog` |

All under `Sources/TermLoop/AgentInputs/`.

## Prompt authoring model

- **`AgentTemplate` remains the launch template.** Its markdown `body`
  is the legacy inline **prompt/task body**, not an implicit system
  prompt.
- Reusable prompt text lives in `AgentPromptDocument`.
  `AgentTemplate.promptDocumentId` can point at a reusable prompt-body
  document; `AgentTemplate.systemPromptDocumentId` can point at a
  reusable system-prompt document.
- `AgentInvocationRequest` may carry per-run prompt/system document id
  overrides, but `AgentInvocationPlan` must carry only resolved text.
  Runtime consumers do not resolve ids.
- **Authoring may be id-based; launch is always text-based.** This keeps
  preview truthful ("nothing hidden ships") while still allowing shared
  prompt libraries.

## Invariants

- **Transport agnostic plan.** `AgentInvocationPlan.resolvedSystemInstructions`
  is one agent-agnostic string. Adapter chooses delivery. Composer must
  not encode argv / tempfile / prefix decisions.
- **Catalog has model authority.** Templates *suggest* a model;
  `AgentCatalogStore.resolveModel(_:for:)` decides validity per agent
  and downgrades to `.default` when the agent doesn't support the
  requested option. `AgentTemplate.Model` ↔ `AgentModelOption` mapping
  helpers are bidirectional and lossless.
- **Disk/watcher truth, never in-memory cache.** `ProjectInstructionStore`
  reads abilities straight from disk per call. The original
  `AbilityInjector` cache-bypass workaround is encoded as the design,
  not a comment.
- **Preview ⇄ launch share the base plan.** `AgentInvocationPlan`
  (including `PreviewSummary`) is the canonical base both preview UI
  and launch read from. Preview may layer *local* run-time overrides
  on top (per-run ability mutes, force-includes — see D1(B)); those
  overrides never enter launch. If preview and launch disagree about
  anything that's *not* a documented override, the composer is wrong —
  fix the composer, not the consumer.
- **No resolver/facade layer.** No `AgentInputResolver`,
  `BridgePromptResolver`, etc. Stores own truth, composer composes,
  queries select. (Mirrors the `TerminalAgentActivityResolver` lesson.)
- **Source typing.** `AgentInvocationSource` is a typed enum;
  `reasonTag: String?` is a free-form supplementary classifier (e.g.
  `"quickAction.freePrompt"`). Don't put runtime intent into
  `reasonTag`.
- **Resolve references in the composer.** `AgentTemplate` / request-level
  prompt document ids are authoring references only. `compose(_:)`
  resolves them into `resolvedPromptBody` / `resolvedUserSystemPrompt`
  before any preview or launch consumer sees the payload.

## Bridge boundary

Bridge **input** assembly (preset catalog, kickoff prompts, ask-agent
helper prompts) lives in `BridgePromptCatalog`. Bridge **runtime**
(state machine, transcript forwarding, idle timeout, pause/resume,
turn limits, polling fallback) stays in `WorkspaceBridgeStore` and
`BridgeCoordinator`. Phase 5 only relocated input.

## Decisions — locked for Phase 4

### D1 — Preview override model → **B (side channel)**

`QuickActionPreviewViewModel` keeps its run-local override state
(`mutedIds`, `forceIncludedIds`). Composer produces the canonical
base plan; preview applies a local override layer on top.

Concretely: add `AgentInvocationComposer.previewPlan(_ request:,
overrides:)` where `overrides` is a preview-only struct
(`PreviewOverrides { muted: Set<String>; forceIncluded: Set<String> }`)
living in `AgentInputs/`. Launch paths call `compose(_:)`; preview
UIs call `previewPlan(_:overrides:)`. Launch truth and preview
experimentation stay separate.

Rationale: the override state is *preview-time* semantics — the user
pokes chips to see what would run. Threading that into
`AgentInvocationRequest` pollutes launch with options that launch
never honors.

### D2 — Model runtime consumption → **A (wire it)**

Phase 4 threads `resolvedModel` into the actual launch argv / env.
Exact wiring:

- Claude: map `.opus` / `.sonnet` / `.default` to the CLI's
  `--model` flag (or equivalent env var — verify at wire time).
- Non-Claude agents: `AgentCatalogStore` downgrades to `.default`
  already; adapter drops the flag when resolution is `.default`.

Rationale: if resolvedModel is semantic-only, `AgentModelOption`
adds a type without closing the override path. Model consolidation
is only real when model actually ships to the agent.

### D3 — Skills wiring → **B (explicit defer)**

Skills are out of scope for this refactor. `ProjectInstructionStore.
snapshot(...)` keeps `referencedSkills: []`. `SkillCatalog` keeps
its popover-scoped view model. A follow-up initiative will wire
skills truth into the store if/when skill activation is part of
runtime input composition.

Rationale: runtime input (abilities, prompts, model, permission)
has one maturity level; skills catalog is another (reference-only,
popover-scoped, no runtime consumption). Forcing them into the same
refactor inflates scope without closing any user-visible gap.

## Phase 4 — Deep consumer migration backlog

Each item migrates a single call-site to consume the composer.
Ordering follows risk: start with runtime-critical paths that already
have 1:1 composer coverage, end with ones gated on the decisions
above.

- [x] **D2(A) landed in `0830c2a1`** — `AgentModelOption` threaded
      through `QuickActionViewModel.launchTerminal` → `QuickActionLauncher`
      → `TerminalAgentLifecycle.createFreshWorkspace` → `Runner.prepareLaunch`.
      Claude `.opus` / `.sonnet` now append `--model <name>` to argv.
      `AgentCatalogStore.resolveModel` is the single authority.
- [x] **QuickAction full composer adoption landed in `d1dea210`** — the
      legacy `AgentRunRequest` + `AgentInvocationRequest+Legacy.swift`
      adapter were deleted. `QuickActionRunResolver.resolve(...)` now
      returns `AgentInvocationRequest` directly; `QuickActionViewModel.
      launchTerminal` calls `AgentInvocationComposer.compose(_:)` and
      reads fields off the resulting plan. The fresh-launch semantic
      gap was closed by splitting `AgentInvocationPlan.resolvedSystem
      Instructions` into `resolvedUserSystemPrompt` (user-scoped only)
      plus the joined form — Lifecycle plan overloads pass the user-
      scoped variant so abilities still aren't injected into fresh
      launches.
- [x] **Phase 4.2 landed in `1fb107f6`** — `Runner.prepareLaunch`
      routes `AgentSystemPromptInjector.resolve` through
      `AgentInvocationTransportAdapter.resolveSystemInstructions(agentId:
      systemInstructions:)`. Behavior identical (adapter delegates
      to injector); architecturally Runner now goes through the
      single composition seam.
- [x] **Phase 4.3 landed in `023ab0fd`** — `TerminalAgentLifecycle+Plan.swift`
      adds `createFreshWorkspace(plan:)` and `forkWorkspace(plan:)`
      overloads that extract composition fields from an
      `AgentInvocationPlan` and delegate to the existing parameter
      API. `launchInExistingWorkspace` left for a future caller that
      actually needs it. Same commit: composer stopped emitting the
      TermLoop reporting prefix (injector is the single owner) and
      `AgentInvocationPlan.resolvedPermission` became optional to
      distinguish "caller didn't override" from "explicitly
      .default".
- [x] **Phase 4.4 landed in `023ab0fd`** — `AskToSheet.submit()` now
      composes via `AgentInvocationComposer` with
      `AgentInvocationSource.askAgent` and launches the helper
      workspace through the Lifecycle plan overload. Preset prompts
      still come from `BridgePromptCatalog.AskAgentPreset`, but the
      composer is the single seam that turns them into a launch
      plan. Bridge runtime path (`WorkspaceBridge` + `BridgeCoordinator.
      kickoff`) untouched.
- [x] `AbilitiesPanel` creator/refiner spawn paths now compose via
      `.abilityCreator` / `.abilityRefiner` source and launch through
      Lifecycle plan overloads.
- [x] Socket / system-prompt preview endpoint now returns the composer
      plan plus transport-visible delivery fields from the same adapter
      seam Quick Action preview uses.
- [x] `QuickActionPreviewViewModel` now reads the composer's
      `previewPlan(_:overrides:)` seam; preview chips mutate local
      overrides, parent recomposes, and rendered system prompt comes
      from the preview plan rather than a second partition path.

### Explicitly out of scope (D3 defer)

Skills wiring into `ProjectInstructionStore` is deferred. If/when
runtime skill activation becomes a requirement, a follow-up initiative
should:
- move `SkillCatalog` scanning into `ProjectInstructionStore`
- populate `ProjectInstructionSnapshot.referencedSkills`
- reduce the popover VM to a thin UI adapter over the store

### Out of Phase 4 scope

- `BridgeKickoffSheet.submit()` — binds two *existing* workspaces
  and kicks off message forwarding via `BridgeCoordinator`. No new
  agent invocation happens here, so this is bridge-runtime work, not
  input composition. Leave it in `WorkspaceBridgeStore` /
  `BridgeCoordinator` domain.

## Phase 6 — Cleanup landed

- [x] `AgentSystemPromptInjector` is transport-only; preview/delivery
      contract flows through `AgentInvocationTransportAdapter`.
- [x] `AbilityInjector` composition helpers are gone; composition now
      lives under `ProjectInstructionStore` / composer.
- [x] `TermLoopTemplateLoader` is gone; bundled prompt reads route
      through `ProjectInstructionStore.loadBundledMarkdown(named:)`.
- [x] `AgentTemplateStore` owns FSEvents/debounce/reload; `TemplateRegistry`
      is retired from production.
- [x] `QuickActionLRUStore.modelOverride` persists `AgentModelOption`.

## Build / verification

`xcodebuild -project GhosttyTabs.xcodeproj -scheme termloop -configuration
Debug -destination 'platform=macOS' -derivedDataPath /tmp/termloop-<tag>
build` was green after every phase landed in this branch. Tests are
not run locally per `termloop/CLAUDE.md`.
