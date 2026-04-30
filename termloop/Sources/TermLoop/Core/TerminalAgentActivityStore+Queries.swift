// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
extension TerminalAgentActivityStore {
    /// Live-preferred variant: bypasses the sticky override so callers that
    /// always want the current raw state see `.ready` instead of a restored
    /// `.completed`. When the presentation is sticky but there is no raw
    /// state available, the sticky displayState is preserved.
    func livePreferredDisplayState(forWorkspace workspace: Workspace) -> TerminalAgentDisplayState {
        livePreferredDisplayState(
            forWorkspace: workspace,
            presentation: presentation(forWorkspaceId: workspace.id)
        )
    }

    /// Overload for hot paths that already resolved the presentation — avoids
    /// a second dictionary lookup inside this helper.
    func livePreferredDisplayState(
        forWorkspace workspace: Workspace,
        presentation: TerminalAgentPresentationState?
    ) -> TerminalAgentDisplayState {
        guard let presentation else { return .idle }
        if presentation.source == .sticky,
           let raw = state(forWorkspaceId: workspace.id) {
            return TerminalAgentPresentationReducer.mapDisplayState(raw)
        }
        return presentation.displayState
    }

    func activeAgentId(forWorkspace workspace: Workspace) -> String? {
        activeAgentId(forWorkspaceId: workspace.id)
    }

    func activeAgentId(forWorkspaceId workspaceId: UUID) -> String? {
        activeAgentId(
            forWorkspaceId: workspaceId,
            presentation: presentation(forWorkspaceId: workspaceId)
        )
    }

    /// Overload for hot paths that already resolved the presentation — avoids
    /// a second dictionary lookup inside this helper.
    func activeAgentId(
        forWorkspaceId workspaceId: UUID,
        presentation: TerminalAgentPresentationState?
    ) -> String? {
        presentation?.agentId
            ?? WorkspaceMetadataStore.shared.terminalAgentId(for: workspaceId)
    }

    /// Full fallback chain: live presentation → persisted agent session →
    /// persisted terminal agent id → registry resolver guess. Use when the
    /// caller needs any agent id hint at all (e.g. menu routing).
    func resolvedAgentId(forWorkspace workspace: Workspace) -> String? {
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspace.id)
        return presentation(forWorkspaceId: workspace.id)?.agentId
            ?? metadata.persistedAgentSession?.agentId
            ?? metadata.terminalAgentId
            ?? TerminalAgentResolver.resolve(workspaceId: workspace.id)?.id
    }

    func isAgentRunning(forWorkspace workspace: Workspace, agentId: String) -> Bool {
        guard let presentation = presentation(forWorkspaceId: workspace.id),
              presentation.source == .live,
              presentation.agentId == agentId else {
            return false
        }
        return presentation.displayState == .running
    }

    func isRunning(forWorkspace workspace: Workspace) -> Bool {
        displayState(forWorkspaceId: workspace.id) == .running
    }

    func hasLiveVisibleActivity(forWorkspace workspace: Workspace) -> Bool {
        guard let presentation = presentation(forWorkspaceId: workspace.id),
              presentation.source == .live else {
            return false
        }
        return presentation.displayState.isVisibleActivity
    }

    func shouldAppearInActiveAgentsPanel(forWorkspace workspace: Workspace) -> Bool {
        guard let presentation = presentation(forWorkspaceId: workspace.id) else {
            return false
        }
        /// Product rule: after app relaunch, every restoreable terminal-agent
        /// workspace should continue to appear in Active Agents. A successful
        /// resume may settle into `.sticky` (`completed`, `needsInput`,
        /// `error`) instead of staying `.live`; those rows must remain visible
        /// rather than flashing in as `.pendingRestore` and then disappearing.
        return presentation.displayState.isVisibleActivity
    }

    func aggregate(for workspaces: [Workspace]) -> TerminalAgentAggregateSummary {
        var runningCount = 0
        var needsInputCount = 0
        var completedCount = 0
        var errorCount = 0
        var latestActivityAt: Date?

        for workspace in workspaces {
            let presentation = self.presentation(forWorkspaceId: workspace.id)
            switch presentation?.displayState ?? .idle {
            case .running:
                runningCount += 1
            case .needsInput:
                needsInputCount += 1
            case .completed:
                completedCount += 1
            case .error:
                errorCount += 1
            case .ready, .idle:
                break
            }
            if let date = presentation?.latestActivityAt {
                latestActivityAt = max(latestActivityAt ?? .distantPast, date)
            }
        }

        let dominantState: TerminalAgentDisplayState = [
            (TerminalAgentDisplayState.error, errorCount),
            (.needsInput, needsInputCount),
            (.running, runningCount),
            (.completed, completedCount)
        ]
        .first { $0.1 > 0 }?.0 ?? .idle

        return TerminalAgentAggregateSummary(
            runningCount: runningCount,
            needsInputCount: needsInputCount,
            completedCount: completedCount,
            errorCount: errorCount,
            dominantState: dominantState,
            latestActivityAt: latestActivityAt
        )
    }
}
