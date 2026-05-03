// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Combine
import SwiftUI

extension ActiveAgentsPanel {
    func projectScopedTabs() -> [Workspace] {
        projectScopedTabs(tabManager.tabs)
    }

    func projectScopedTabs(_ tabs: [Workspace]) -> [Workspace] {
        TermLoopSidebar.projectScopedTabs(allTabs: tabs)
    }

    func normalizedWorktreeBranch(for workspace: Workspace) -> String? {
        let persisted = WorkspaceMetadataStore.shared.branch(for: workspace)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !persisted.isEmpty {
            return persisted
        }

        let cwd = workspace.currentDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard WorktreeResolver.worktreeRoot(containing: cwd) != nil else {
            return nil
        }
        let inferred = (workspace.gitBranch?.branch ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return inferred.isEmpty ? nil : inferred
    }

    func currentHeaderBranch(snapshot: ActiveAgentsWorkspaceSnapshot) -> String? {
        // Restrict the header branch to workspaces actually visible in the
        // Active Agents panel. Worktree-backed (Merged/Open PRs, Worktree
        // Agents) tabs surface in WorktreeAgentsPanel — selecting one of those
        // must not bleed its branch into the Active Agents header.
        let eligibleTabs = snapshot.tabs.filter { snapshot.isVisibleInLoopPanel(workspaceId: $0.id) }

        if let selectedTabId = tabManager.selectedTabId,
           let selectedWorkspace = eligibleTabs.first(where: { $0.id == selectedTabId }),
           let branch = currentWorkspaceBranch(for: selectedWorkspace, snapshot: snapshot) {
            return branch
        }

        for workspace in eligibleTabs {
            if let branch = currentWorkspaceBranch(for: workspace, snapshot: snapshot) {
                return branch
            }
        }

        return nil
    }

    private func currentWorkspaceBranch(
        for workspace: Workspace,
        snapshot: ActiveAgentsWorkspaceSnapshot
    ) -> String? {
        if let worktreeBranch = snapshot.worktreeBranchByWorkspaceId[workspace.id] {
            return worktreeBranch
        }

        let branch = (workspace.gitBranch?.branch ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return branch.isEmpty ? nil : branch
    }

    func branchObservationKeys(for tabs: [Workspace]) -> [BranchObservationKey] {
        tabs.map { workspace in
            let branch = normalizedWorktreeBranch(for: workspace)
            return BranchObservationKey(workspaceId: workspace.id, branch: branch)
        }
    }

    func workspaceTitleSignatures(for tabs: [Workspace]) -> [ActiveAgentsWorkspaceTitleSignature] {
        tabs.map { workspace in
            ActiveAgentsWorkspaceTitleSignature(
                workspaceId: workspace.id,
                title: workspace.title,
                customTitle: workspace.customTitle
            )
        }
    }

    func makeActiveAgentsWorkspaceSnapshot(tabs scopedTabs: [Workspace]? = nil) -> ActiveAgentsWorkspaceSnapshot {
        let tabs = scopedTabs ?? projectScopedTabs()
        let workspaceById = Dictionary(uniqueKeysWithValues: tabs.map { ($0.id, $0) })
        let hiddenWorkspaceIds = Set(
            tabs.compactMap { workspace in
                WorkspaceMetadataStore.shared.isHiddenFromWorkspaceTree(workspaceId: workspace.id)
                    ? workspace.id
                    : nil
            }
        )
        let askAgentHelperWorkspaceIds = Set<UUID>(
            bridgeStore.bridges.compactMap { bridge in
                guard bridge.intent == .askAgent else { return nil }
                return bridge.rightWorkspaceId
            }
        )
        let curatorForkWorkspaceIds = ContextBankAnalysisCoordinator.shared
            .activeCuratorForkWorkspaceIds
        let worktreeBranchByWorkspaceId = Dictionary(
            uniqueKeysWithValues: tabs.compactMap { workspace in
                normalizedWorktreeBranch(for: workspace).map { (workspace.id, $0) }
            }
        )
        let worktreeBackedIds = Set(worktreeBranchByWorkspaceId.keys)
        return ActiveAgentsWorkspaceSnapshot(
            tabs: tabs,
            workspaceById: workspaceById,
            worktreeBackedIds: worktreeBackedIds,
            worktreeBranchByWorkspaceId: worktreeBranchByWorkspaceId,
            hiddenWorkspaceIds: hiddenWorkspaceIds,
            askAgentHelperWorkspaceIds: askAgentHelperWorkspaceIds,
            curatorForkWorkspaceIds: curatorForkWorkspaceIds
        )
    }

    /// Scope for the restore button's session scan: every tracked workspace's
    /// cwd, plus the active project's folder path as a fallback.
    func resumeCwds(tabs: [Workspace]) -> [String] {
        var results: [String] = []
        for tab in tabs {
            let dir = tab.currentDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
            if !dir.isEmpty {
                results.append(dir)
            }
        }
        if let activeId = ProjectStore.shared.activeProjectId,
           let project = ProjectStore.shared.project(id: activeId) {
            results.append(project.folderPath)
        }
        return results
    }

    func computeAbilitySessions(
        snapshot: ActiveAgentsWorkspaceSnapshot
    ) -> [AbilityAgentSession] {
        snapshot.tabs
            .filter {
                !snapshot.worktreeBackedIds.contains($0.id)
                    && !snapshot.hiddenWorkspaceIds.contains($0.id)
                    && !snapshot.askAgentHelperWorkspaceIds.contains($0.id)
                    && !snapshot.curatorForkWorkspaceIds.contains($0.id)
            }
            .compactMap {
                WorkspaceMetadataStore.shared.abilitySession(forWorkspaceId: $0.id)
            }
            .sorted {
                if $0.spawnedAt != $1.spawnedAt {
                    return $0.spawnedAt > $1.spawnedAt
                }
                return $0.workspaceId.uuidString < $1.workspaceId.uuidString
            }
    }

    func computeTerminalSessions(
        snapshot: ActiveAgentsWorkspaceSnapshot
    ) -> [TerminalAgentLiveSession] {
        return snapshot.tabs
            .filter { snapshot.isVisibleInLoopPanel(workspaceId: $0.id) }
            .compactMap { workspace -> TerminalAgentLiveSession? in
                // Ability-owned workspaces have their own Active Agents row;
                // do not also render the same workspace as a generic terminal.
                guard WorkspaceMetadataStore.shared.abilitySession(forWorkspaceId: workspace.id) == nil else {
                    return nil
                }
                guard TerminalAgentActivityStore.shared.shouldAppearInActiveAgentsPanel(forWorkspace: workspace),
                      let presentation = TerminalAgentActivityStore.shared
                        .presentation(forWorkspaceId: workspace.id) else {
                    return nil
                }
                let latestActivityAt = presentation.latestActivityAt ?? Date()
                if attentionMute.isMuted(workspaceId: workspace.id, currentUpdatedAt: latestActivityAt) {
                    return nil
                }
                let core = AgentRowSnapshotBuilder.build(
                    workspace: workspace,
                    presentation: presentation,
                    branchLabel: nil,
                    policy: .presentation
                )
                return TerminalAgentLiveSession(
                    core: core,
                    updatedAt: latestActivityAt
                )
            }
        .sorted {
            if $0.phaseSortOrder != $1.phaseSortOrder {
                return $0.phaseSortOrder < $1.phaseSortOrder
            }
            let lhsRecency = $0.core.lastUserPromptAt ?? $0.core.since ?? $0.updatedAt
            let rhsRecency = $1.core.lastUserPromptAt ?? $1.core.since ?? $1.updatedAt
            if lhsRecency != rhsRecency {
                return lhsRecency > rhsRecency
            }
            return $0.core.workspaceId.uuidString < $1.core.workspaceId.uuidString
        }
    }

    func computeBridgeSessions(
        snapshot: ActiveAgentsWorkspaceSnapshot
    ) -> [WorkspaceBridge] {
        scopedBridges(snapshot: snapshot)
            .sorted {
                bridgeSortPriority($0.state) < bridgeSortPriority($1.state)
                    || (bridgeSortPriority($0.state) == bridgeSortPriority($1.state)
                        && bridgeUpdatedAt($0) > bridgeUpdatedAt($1))
            }
    }

    func computePanelCounts(
        snapshot: ActiveAgentsWorkspaceSnapshot
    ) -> ActiveAgentsPanelCountSnapshot {
        var counts = ActiveAgentsPanelCountSnapshot()

        for workspace in snapshot.tabs {
            guard !snapshot.worktreeBackedIds.contains(workspace.id),
                  !snapshot.hiddenWorkspaceIds.contains(workspace.id),
                  !snapshot.askAgentHelperWorkspaceIds.contains(workspace.id),
                  !snapshot.curatorForkWorkspaceIds.contains(workspace.id) else {
                continue
            }
            if WorkspaceMetadataStore.shared.abilitySession(forWorkspaceId: workspace.id) != nil {
                // Keep the collapsed header count aligned with the expanded
                // row model: an ability workspace contributes exactly one row.
                counts.abilitySessions += 1
                continue
            }
            guard let presentation = TerminalAgentActivityStore.shared
                .presentation(forWorkspaceId: workspace.id) else {
                continue
            }
            let latestActivityAt = presentation.latestActivityAt ?? Date()
            if attentionMute.isMuted(workspaceId: workspace.id, currentUpdatedAt: latestActivityAt) {
                continue
            }
            switch presentation.displayState {
            case .idle, .ready:
                break
            case .running:
                counts.runningTerminals += 1
            case .needsInput, .error:
                counts.waitingTerminals += 1
            case .completed:
                counts.finishedTerminals += 1
            }
        }

        for bridge in scopedBridges(snapshot: snapshot) {
            switch bridge.state {
            case .running:
                counts.runningBridges += 1
            case .stopped:
                counts.finishedBridges += 1
            }
        }
        return counts
    }

    private func scopedBridges(
        snapshot: ActiveAgentsWorkspaceSnapshot
    ) -> [WorkspaceBridge] {
        bridgeStore.bridges.filter { bridge in
            snapshot.workspaceById[bridge.leftWorkspaceId] != nil
                && snapshot.workspaceById[bridge.rightWorkspaceId] != nil
                && !snapshot.worktreeBackedIds.contains(bridge.leftWorkspaceId)
        }
    }

    func makeActiveAgentsExpandedRenderSnapshot(
        tabs: [Workspace]? = nil
    ) -> ActiveAgentsExpandedRenderSnapshot {
        PanelRenderInstrumentation.measure(.activeAgents) {
            makeActiveAgentsExpandedRenderSnapshotCore(tabs: tabs)
        }
    }

    private func makeActiveAgentsExpandedRenderSnapshotCore(
        tabs: [Workspace]? = nil
    ) -> ActiveAgentsExpandedRenderSnapshot {
        let workspaceSnapshot = makeActiveAgentsWorkspaceSnapshot(tabs: tabs)
        let sessions = computeAbilitySessions(snapshot: workspaceSnapshot)
        let terminalSessions = computeTerminalSessions(snapshot: workspaceSnapshot)
        let bridges = computeBridgeSessions(snapshot: workspaceSnapshot)
        let terminalCounts = terminalSessions.reduce(into: (running: 0, waiting: 0, finished: 0)) { acc, s in
            switch s.core.displayState {
            case .running: acc.running += 1
            case .needsInput, .error: acc.waiting += 1
            case .completed: acc.finished += 1
            case .idle, .ready: break
            }
        }
        let bridgeCounts = bridges.reduce(into: (running: 0, stopped: 0)) { acc, b in
            switch b.state {
            case .running: acc.running += 1
            case .stopped: acc.stopped += 1
            }
        }
        let runningCount = sessions.count + terminalCounts.running + bridgeCounts.running
        let waitingCount = terminalCounts.waiting
        let finishedCount = terminalCounts.finished + bridgeCounts.stopped
        let groupedBridges = bridgeGroups(bridges)
        let terminalSessionIds = Set(terminalSessions.map(\.core.workspaceId))
        let orphanBridges = bridges.filter { !terminalSessionIds.contains($0.leftWorkspaceId) }
        let allTargets = navigationTargets(
            terminalSessions: terminalSessions,
            groupedBridges: groupedBridges,
            orphanBridges: orphanBridges,
            sessions: sessions
        )
        let branchSummaryWorkspaceIds =
            visibleWorkspaceIds(in: terminalSessions)
            + sessions.map(\.workspaceId)
        let branchSummaryByWorkspaceId = branchSummaryCache(
            workspaceIds: branchSummaryWorkspaceIds,
            workspaceById: workspaceSnapshot.workspaceById
        )
        let contextMenuContext = ActiveAgentWorkspaceContextMenuBuildContext.live(tabs: workspaceSnapshot.tabs)
        let contextMenuSourceIds = Set(terminalSessions.map(\.core.workspaceId) + sessions.map(\.workspaceId))
        let contextMenuSnapshotsByWorkspaceId = Dictionary(
            uniqueKeysWithValues: contextMenuSourceIds.compactMap { workspaceId -> (UUID, ActiveAgentWorkspaceContextMenuSnapshot)? in
                guard let snapshot = ActiveAgentWorkspaceContextMenuSnapshot.build(
                    workspaceId: workspaceId,
                    tabs: workspaceSnapshot.tabs,
                    context: contextMenuContext
                ) else {
                    return nil
                }
                return (workspaceId, snapshot)
            }
        )
        return ActiveAgentsExpandedRenderSnapshot(
            workspaceSnapshot: workspaceSnapshot,
            sessions: sessions,
            terminalSessions: terminalSessions,
            bridges: bridges,
            runningCount: runningCount,
            waitingCount: waitingCount,
            finishedCount: finishedCount,
            groupedBridges: groupedBridges,
            orphanBridges: orphanBridges,
            allTargets: allTargets,
            branchSummaryByWorkspaceId: branchSummaryByWorkspaceId,
            contextMenuSnapshotsByWorkspaceId: contextMenuSnapshotsByWorkspaceId,
            hasAny: !sessions.isEmpty || !terminalSessions.isEmpty || !bridges.isEmpty
        )
    }

    func bridgeGroups(_ bridges: [WorkspaceBridge]) -> [UUID: [WorkspaceBridge]] {
        Dictionary(grouping: bridges, by: \.leftWorkspaceId)
    }

    func bridgeSortPriority(_ state: BridgeState) -> Int {
        switch state {
        case .running: return 0
        case .stopped: return 1
        }
    }

    func bridgeUpdatedAt(_ bridge: WorkspaceBridge) -> Date {
        bridge.messages.last?.timestamp ?? bridge.createdAt
    }

}


extension ActiveAgentsPanel {
    func activeAgentsActivityObservationPublisher() -> AnyPublisher<[ActiveAgentsActivityObservationKey], Never> {
        let relevantWorkspaceIds = Array(NSOrderedSet(array: projectScopedTabs().map(\.id))) as? [UUID] ?? []
        return Publishers.CombineLatest(
            TerminalAgentActivityStore.shared.$statesByWorkspaceId,
            TerminalAgentActivityStore.shared.$pendingPlaceholderByWorkspaceId
        )
        .map { statesByWorkspaceId, pendingByWorkspaceId in
            relevantWorkspaceIds.map { workspaceId in
                ActiveAgentsActivityObservationKey(
                    workspaceId: workspaceId,
                    state: statesByWorkspaceId[workspaceId],
                    hasPendingRestore: pendingByWorkspaceId[workspaceId] != nil
                )
            }
        }
        .removeDuplicates()
        .throttle(for: .milliseconds(120), scheduler: RunLoop.main, latest: true)
        .eraseToAnyPublisher()
    }

    func branchSummaryCache(
        workspaceIds: [UUID],
        workspaceById: [UUID: Workspace]
    ) -> [UUID: String] {
        branchSummaryMemo.value(
            for: ActiveAgentsBranchSummarySignature(
                workspaceIds: Array(Set(workspaceIds)).sorted { $0.uuidString < $1.uuidString },
                branchTick: branchTick
            )
        ) {
            buildBranchSummaryIndex(
                workspaceIds: workspaceIds,
                workspaceById: workspaceById
            )
        }
    }
}
