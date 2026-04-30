// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

struct ActiveAgentsWorkspaceSnapshot {
    let tabs: [Workspace]
    let workspaceById: [UUID: Workspace]
    let worktreeBackedIds: Set<UUID>
    let worktreeBranchByWorkspaceId: [UUID: String]
    let hiddenWorkspaceIds: Set<UUID>
    let askAgentHelperWorkspaceIds: Set<UUID>
    /// Workspaces created as curator forks by `ContextBankAnalysisCoordinator`.
    /// These tabs surface inside the Context Bank "Analysis Agents" panel
    /// instead — the active-agents panel suppresses them so the Loop tab
    /// stays focused on user-facing work.
    let curatorForkWorkspaceIds: Set<UUID>

    /// Single visibility predicate for the Loop tab's row list. Any
    /// workspace flagged by one of these classifications has a dedicated
    /// home elsewhere (worktree panel, hidden helper, askAgent right-side
    /// helper, curator fork) and must not double-render in Loop.
    func isVisibleInLoopPanel(workspaceId id: UUID) -> Bool {
        !worktreeBackedIds.contains(id)
            && !hiddenWorkspaceIds.contains(id)
            && !askAgentHelperWorkspaceIds.contains(id)
            && !curatorForkWorkspaceIds.contains(id)
    }
}

struct ActiveAgentsExpandedRenderSignature: Equatable {
    let workspaceIds: [UUID]
    let selectedTabId: UUID?
    let agentSessionTick: Int
    let projectScopeTick: Int
    let activityTick: Int
    let bridgeOverviewTick: Int
    let branchTick: Int
    let attentionMuteTick: Int
}

@MainActor
final class ActiveAgentsExpandedRenderMemo {
    private var signature: ActiveAgentsExpandedRenderSignature?
    private var snapshot: ActiveAgentsExpandedRenderSnapshot?

    func value(
        for signature: ActiveAgentsExpandedRenderSignature,
        build: () -> ActiveAgentsExpandedRenderSnapshot
    ) -> ActiveAgentsExpandedRenderSnapshot {
        if self.signature == signature, let snapshot {
            return snapshot
        }
        let next = build()
        self.signature = signature
        self.snapshot = next
        return next
    }
}

struct ActiveAgentsExpandedRenderSnapshot {
    let workspaceSnapshot: ActiveAgentsWorkspaceSnapshot
    let sessions: [AbilityAgentSession]
    let terminalSessions: [TerminalAgentLiveSession]
    let bridges: [WorkspaceBridge]
    let runningCount: Int
    let waitingCount: Int
    let finishedCount: Int
    let groupedBridges: [UUID: [WorkspaceBridge]]
    let orphanBridges: [WorkspaceBridge]
    let allTargets: [ActiveAgentsNavigationTarget]
    let branchSummaryByWorkspaceId: [UUID: String]
    let contextMenuSnapshotsByWorkspaceId: [UUID: ActiveAgentWorkspaceContextMenuSnapshot]
    let hasAny: Bool
}


struct ActiveAgentsBranchSummarySignature: Equatable {
    let workspaceIds: [UUID]
    let branchTick: Int
}

@MainActor
final class ActiveAgentsBranchSummaryMemo {
    private var signature: ActiveAgentsBranchSummarySignature?
    private var cache: [UUID: String]?

    func value(
        for signature: ActiveAgentsBranchSummarySignature,
        build: () -> [UUID: String]
    ) -> [UUID: String] {
        if self.signature == signature, let cache {
            return cache
        }
        let next = build()
        self.signature = signature
        self.cache = next
        return next
    }
}

struct ActiveAgentsActivityObservationKey: Equatable {
    let workspaceId: UUID
    let state: TerminalAgentActivityState?
    let hasPendingRestore: Bool
}

struct ActiveAgentsPanelCountSnapshot {
    var abilitySessions: Int = 0
    var runningTerminals: Int = 0
    var waitingTerminals: Int = 0
    var finishedTerminals: Int = 0
    var runningBridges: Int = 0
    var finishedBridges: Int = 0
}

enum ActiveAgentsNavigationTarget: Hashable {
    case terminal(UUID)
    case bridge(UUID)
    case ability(UUID)
}
