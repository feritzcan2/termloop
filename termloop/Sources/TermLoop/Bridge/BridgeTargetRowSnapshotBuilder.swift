// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Builds an `AgentRowPresentationSnapshot` for a bridge's right endpoint so
/// `AgentRowCoreView` can render bridge rows with the same vocabulary as the
/// ActiveAgents/Worktree/Ticket panels.
///
/// When the right workspace exists, presentation truth flows from
/// `AgentRowSnapshotBuilder` (same path all other panels use). When no
/// workspace exists — the askAgent helper window has been closed, or the
/// workspace is hidden — `bridge.state` is the only truth, so display state is
/// synthesized from it and preview/branch are intentionally nil.
@MainActor
enum BridgeTargetRowSnapshotBuilder {
    static func build(
        bridge: WorkspaceBridge,
        rightTitle: String,
        rightWorkspace: Workspace?
    ) -> AgentRowPresentationSnapshot {
        let bridgeClock = bridge.messages.last?.timestamp ?? bridge.createdAt

        if let workspace = rightWorkspace {
            let base = AgentRowSnapshotBuilder.build(
                workspace: workspace,
                branchLabel: nil,
                policy: .presentation
            )
            return base.with(
                title: rightTitle,
                branchLabel: nil,
                since: base.since ?? bridgeClock
            )
        }

        let displayState: TerminalAgentDisplayState = {
            switch bridge.state {
            case .running: return .running
            case .stopped: return .completed
            }
        }()
        let agentId = TerminalAgentActivityStore.shared
            .activeAgentId(forWorkspaceId: bridge.rightWorkspaceId)
        return AgentRowPresentationSnapshot(
            workspaceId: bridge.rightWorkspaceId,
            title: rightTitle,
            agentId: agentId,
            agentLabel: TerminalAgentDisplayFormatter.agentDisplayLabel(
                agentId: agentId,
                fallback: TerminalAgent.claudeId
            ),
            stateText: TerminalAgentDisplayFormatter.stateText(
                for: displayState,
                preview: nil
            ),
            displayState: displayState,
            branchLabel: nil,
            preview: nil,
            since: bridgeClock,
            lastUserPromptAt: nil
        )
    }
}
