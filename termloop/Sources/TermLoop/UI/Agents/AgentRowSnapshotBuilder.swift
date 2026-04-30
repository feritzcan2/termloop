// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// Policy deciding which display-state a panel renders.
///
/// ActiveAgents preserves sticky restore states (`.presentation`) — after app
/// relaunch, a workspace that settled into `completed`/`needsInput`/`error`
/// must keep showing that, not flash in as `.pendingRestore` and disappear.
///
/// Worktree/Ticket panels prefer live (`.livePreferred`) — a sticky snapshot
/// should collapse to the current raw activity state when raw is available.
@MainActor
enum AgentRowDisplayStatePolicy {
    case presentation
    case livePreferred
}

/// Shared UI-side assembly of the common agent-row presentation snapshot.
///
/// Lives in UI/ on purpose: title resolution, branchLabel pass-through, and
/// stateText formatting are row-assembly concerns. The store/query layer owns
/// truth and predicates only.
@MainActor
enum AgentRowSnapshotBuilder {
    private static let logger = Logger(
        subsystem: "com.termloop.fork",
        category: "agent-lifecycle.ui"
    )

    private static func lifecycleLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        let rendered = message()
        logger.debug("\(rendered, privacy: .public)")
        #endif
    }

    /// Removes trailing `(Agent Name)` parens from a workspace title.
    /// Matches case-insensitively against known agent CLIs so titles authored
    /// by humans containing other parenthetical content (e.g. "Fix bug (P0)")
    /// are left untouched.
    private static let agentParenRegex: NSRegularExpression? = {
        let pattern = #"(\s*\((?:claude(?:\s+code)?|codex(?:\s+cli)?|gemini(?:\s+cli)?|aider|cursor)\))+\s*$"#
        return try? NSRegularExpression(pattern: pattern, options: .caseInsensitive)
    }()

    private static func stripTrailingAgentParens(_ title: String) -> String {
        guard let regex = agentParenRegex else { return title }
        let range = NSRange(title.startIndex..., in: title)
        let stripped = regex.stringByReplacingMatches(
            in: title,
            options: [],
            range: range,
            withTemplate: ""
        )
        let trimmed = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        // Defensive: if the title was *only* "(Claude Code)" with nothing
        // else, fall back to the original so we never produce an empty title.
        return trimmed.isEmpty ? title : trimmed
    }

    static func build(
        workspace: Workspace,
        branchLabel: String?,
        policy: AgentRowDisplayStatePolicy
    ) -> AgentRowPresentationSnapshot {
        let store = TerminalAgentActivityStore.shared
        let presentation = store.presentation(forWorkspaceId: workspace.id)
        return build(
            workspace: workspace,
            presentation: presentation,
            branchLabel: branchLabel,
            policy: policy
        )
    }

    /// Overload for hot paths that already resolved `presentation` — avoids a
    /// second dictionary lookup.
    static func build(
        workspace: Workspace,
        presentation: TerminalAgentPresentationState?,
        branchLabel: String?,
        policy: AgentRowDisplayStatePolicy
    ) -> AgentRowPresentationSnapshot {
        let store = TerminalAgentActivityStore.shared

        let displayState: TerminalAgentDisplayState
        switch policy {
        case .presentation:
            displayState = presentation?.displayState ?? .idle
        case .livePreferred:
            displayState = store.livePreferredDisplayState(
                forWorkspace: workspace,
                presentation: presentation
            )
        }

        let agentId = store.activeAgentId(
            forWorkspaceId: workspace.id,
            presentation: presentation
        )

        let custom = workspace.customTitle?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let rawTitle = custom.isEmpty ? workspace.title : custom
        let trimmedTitle = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let baseTitle = trimmedTitle.isEmpty ? rawTitle : trimmedTitle
        // Strip trailing agent-name parens like "(Claude Code)" / "(Codex CLI)"
        // — multi-agent workspaces accumulate one paren per binding, producing
        // titles like `promths (Claude Code) (Claude Code) (Codex CLI)`. The
        // agent label is already rendered separately in row metadata with a
        // colored tint, so the parens are pure duplication. This is a defensive
        // post-process: the upstream title-mutator stays untouched, the row
        // just sees a clean title.
        let title = stripTrailingAgentParens(baseTitle)
        lifecycleLog(
            "ui.snapshot workspace=\(workspace.id.uuidString) policy=\(policy == .presentation ? "presentation" : "livePreferred") source=\(presentation?.source.rawValue ?? "nil") display=\(displayState.rawValue) presentationDisplay=\(presentation?.displayState.rawValue ?? "nil") agent=\(agentId ?? "nil") branch=\(branchLabel ?? "nil") preview=\(presentation?.preview ?? "nil")"
        )

        return AgentRowPresentationSnapshot(
            workspaceId: workspace.id,
            title: title,
            agentId: agentId,
            agentLabel: TerminalAgentDisplayFormatter.agentDisplayLabel(
                agentId: agentId
            ),
            stateText: TerminalAgentDisplayFormatter.stateText(
                for: displayState,
                preview: presentation?.preview
            ),
            displayState: displayState,
            branchLabel: branchLabel,
            preview: presentation?.preview,
            since: presentation?.since,
            lastUserPromptAt: presentation?.lastUserPromptAt
        )
    }
}
