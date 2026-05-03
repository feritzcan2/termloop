# Notification System Architecture

Centralized architecture for terminal-agent activity, attention, and notification
state in `TermLoop`.

This document describes the model used to make `Claude`, `Codex`, and future
terminal agents behave the same way for:

- sidebar status color
- waiting / needs-input state
- workspace attention events
- resume clearing
- Active Agents panel visibility
- stale running cleanup
- notification suppression

## Problem

The previous system was split across multiple Claude-only code paths:

- hook events were mapped differently for Claude vs other agents
- UI read `statusEntries["claude_code"]` directly
- attention metadata lived in compatibility fields only
- Active Agents modeled headless runs and ability sessions, but not general
  terminal agents
- resume and clear flows were hard-coded around Claude session state

That design made `Codex` fail to enter the yellow waiting state and made it
costly to add new agents.

## Goals

- one runtime model for all terminal agents
- one event normalization path from hooks into app state
- one selector layer for UI state
- backwards compatibility for legacy Claude/mobile flows
- future agents should only need registry + hook wiring, not custom UI logic

## Source Of Truth

The source of truth is `TerminalAgentActivityStore`.

Code:
- `termloop/Sources/TermLoop/Core/TerminalAgentActivityStore.swift`

Core types:

```swift
enum TerminalAgentActivityPhase {
  case inactive
  case running
  case waiting
  case failed
}

enum TerminalAgentAttentionKind {
  case completion
  case notification
  case permission
  case userInput
  case error
}

struct TerminalAgentActivityState {
  let workspaceId: UUID
  let agentId: String
  var phase: TerminalAgentActivityPhase
  var attentionKind: TerminalAgentAttentionKind?
  var preview: String?
  var waitingSince: Int?
  var sessionId: String?
  var cwd: String?
  var pid: pid_t?
  var startedAt: Date?
  var updatedAt: Date
}
```

Meaning:

- `running`: agent is actively working
- `waiting`: agent finished a turn or needs attention from the user
- `inactive`: no current visible activity
- `failed`: terminal-agent specific error state

## Agent Identity

Each terminal agent has a stable `statusKey`.

Code:
- `termloop/Sources/TermLoop/AgentTerminals/TerminalAgent.swift`
- `termloop/Sources/TermLoop/AgentTerminals/TerminalAgentRegistry.swift`

Example mapping:

- `claude -> claude_code`
- `codex -> codex`
- `opencode -> opencode`
- `aider -> aider`

The registry owns these identifiers so UI and socket code no longer invent
per-agent strings independently.

## Event Pipeline

All terminal-agent hooks normalize into the same socket RPCs:

- `workspace.report_agent_activity`
- `workspace.clear_agent_activity`

CLI bridge:
- `termloop/CLI/TermLoop/TermLoopCLICommands.swift`

App handlers:
- `termloop/Sources/TermLoop/Socket/TermLoopHooks+Events.swift`
- `termloop/Sources/TermLoop/Socket/TermLoopSocketCommands.swift`

### Input events

Hook producers emit raw events such as:

- session start
- prompt submit
- notification
- stop
- session end
- pre-tool-use

### Normalized phases

Those raw events map into centralized phases:

- `session-start -> inactive`
- `prompt-submit -> running`
- `pre-tool-use -> running`
- `notification -> waiting`
- `stop -> waiting`
- `session-end -> clear activity`

### Attention classification

Waiting states may carry an attention kind:

- normal completion -> `completion`
- generic notification -> `notification`
- approval needed -> `permission`
- explicit error wording -> `error`

Compatibility mapping remains available for legacy code:

- `completion` and `userInput` map to legacy `"stop"`
- `notification`, `permission`, `error` map to legacy `"notification"`

## Compatibility Layer

Legacy metadata still exists in `WorkspaceMetadataStore` and is still written
from the normalized pipeline.

Compatibility fields:

- `awaitingInputSince`
- `lastMessagePreview`
- `lastMessageKind`

Rule:

- new code should read `TerminalAgentActivityStore`
- legacy fields are write-through compatibility, not the primary model

## UI Read Path

UI should not read `statusEntries["claude_code"]` directly to infer behavior.

Central selector layer:
- `termloop/Sources/TermLoop/Core/TerminalAgentActivityResolver.swift`

Selectors:

- `isRunning(workspace:)`
- `isWaiting(workspace:)`
- `hasAttention(workspace:)`
- `state(forWorkspaceId:)`

These selectors:

- prefer centralized activity state
- fall back to legacy status entries only where necessary

## Sidebar Status

The normalization layer updates compatibility sidebar rows so existing
workspace rendering keeps working.

Current mapping:

- `running -> value: "Running", icon: bolt.fill, color: blue`
- `waiting -> value: "Needs input", icon: bell.fill, color: amber`
- `failed -> value: "Error", icon: exclamationmark.triangle.fill, color: red`
- `inactive -> remove status row`

## Workspace Events

The centralized pipeline is responsible for publishing workspace events.

### `workspace.attention`

Published when phase becomes `waiting`.

Payload includes:

- `kind`
- `attention_kind`
- `message_preview`
- `awaiting_since`
- `agent_id`

### `workspace.resumed`

Published when:

- previous state was waiting
- new phase becomes running

This clears compatibility waiting metadata and tells consumers the agent
resumed work.

### `workspace.clear_attention`

Still supported for compatibility, but now also clears centralized waiting
activity.

## Active Agents Panel

The Active Agents panel is no longer limited to headless runs and ability
sessions.

Code:
- `termloop/Sources/TermLoop/UI/Agents/AgentsSidebarStatusPill.swift`

It now renders three categories together:

- headless agent runs
- ability sessions
- terminal-agent live sessions from `TerminalAgentActivityStore`

Terminal-agent rows show:

- workspace title
- agent label
- phase label
- elapsed time
- waiting/running color state

## Stale State Cleanup

Old cleanup logic only knew how to clear stale `claude_code = Running`.

Now:

- `StaleRunningStatusReconciler` walks centralized activity states
- checks `phase == running`
- checks the tracked PID
- clears stale running state if the process is gone and the state is old

Code:
- `termloop/Sources/TermLoop/Core/StaleRunningStatusReconciler.swift`

## Notification Suppression

Raw OSC desktop notifications from terminal surfaces are suppressed when a
workspace is already under terminal-agent hook management.

Reason:

- hook-driven notifications have lifecycle semantics
- raw terminal notifications do not
- showing both leads to duplicates and stale alerts

Code:
- `termloop/Sources/GhosttyTerminalView.swift`

Remote/mobile push follows the same intent:

- if TermLoop is focused and the selected workspace is the one that entered
  `waiting`, APNs push is suppressed
- repeated non-urgent pushes for the same workspace are rate-limited with a
  short cooldown
- urgent waits such as `permission` and `error` bypass cooldown

Code:
- `termloop/Sources/TermLoop/Push/PushDispatcher.swift`

## Workspace Summary Payload

Workspace summary payloads now expose centralized agent activity fields in
addition to legacy Claude fields.

Code:
- `termloop/Sources/TermLoop/Hooks/TerminalController+TermLoop.swift`

Added fields:

- `agent_activity_phase`
- `agent_attention_kind`
- `agent_activity_preview`
- `agent_activity_updated_at`

## Extension Rules

To add a new terminal agent, do not duplicate Claude logic.

Required steps:

1. Add the agent to `TerminalAgentRegistry` with:
   - `id`
   - `displayName`
   - `statusKey`
   - executable metadata
2. Ensure its CLI hook path emits:
   - `reportAgentActivity(...)`
   - `clearAgentActivity(...)`
3. Reuse normalized phases:
   - `running`
   - `waiting`
   - `inactive`
   - `failed`
4. Do not add UI branches keyed on the new agent string.
5. Use `TerminalAgentActivityResolver` in new UI code.

If a new agent has special lifecycle semantics, handle them in the hook-to-phase
mapping layer, not in the UI.

## Non-Goals

This architecture does not yet fully generalize session restore capability.

Still Claude-specific today:

- persisted Claude session scanning
- `claude --resume`
- Claude session file discovery / migration rules

That is a separate capability layer. Activity/notification centralization was
done first because it is shared across all agents.

## Testing Strategy

Primary coverage lives in:

- `termloop/termloopTests/InternalHookEventTests.swift`
- `termloop/termloopTests/WorkspaceResumedEventTests.swift`

What should be tested:

- waiting activity writes centralized store
- waiting activity publishes `workspace.attention`
- running after waiting publishes `workspace.resumed`
- clear activity removes centralized state
- preview truncation stays bounded
- UI selectors work without Claude-specific keys

## Design Rule Summary

- centralized store is the source of truth
- socket normalization owns phase transitions
- compatibility metadata is write-through only
- UI reads selectors, not raw agent-specific keys
- new agents should plug into the registry and hook bridge, not fork the model
