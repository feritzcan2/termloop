// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Bonsplit
import SwiftUI

extension ActiveAgentsPanel {
    var body: some View {
        let scopedTabs = projectScopedTabs()
        let _ = agentSessionTick
        let _ = projectScopeTick
        let _ = activityTick
        let _ = bridgeOverviewTick
        let _ = curatorForkTick
        let _ = workspaceTitleTick
        return Group {
            if !isHidden {
                if isCollapsed {
                    collapsedBody(scopedTabs: scopedTabs)
                } else {
                    expandedBody(scopedTabs: scopedTabs)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .onReceive(WorkspaceMetadataStore.shared.$agentSessionVersion) { newValue in
            guard newValue != agentSessionTick else { return }
            agentSessionTick = newValue
        }
        .onReceive(WorkspaceMetadataStore.shared.$projectScopeVersion) { newValue in
            guard newValue != projectScopeTick else { return }
            projectScopeTick = newValue
        }
        .onReceive(TerminalAgentActivityStore.shared.$presentationVersion) { newValue in
            guard newValue != activityTick else { return }
            if AppMenuTrackingGate.shared.isTrackingMenu {
                pendingActivityTick = newValue
                return
            }
            activityTick = newValue
        }
        .onReceive(WorkspaceMetadataStore.shared.$branchVersion) { _ in
            let nextKeys = branchObservationKeys(for: scopedTabs)
            guard nextKeys != observedBranchKeys else { return }
            observedBranchKeys = nextKeys
            branchTick &+= 1
        }
        .onReceive(WorkspaceMetadataStore.shared.$titleVersion) { newValue in
            guard newValue != workspaceTitleTick else { return }
            workspaceTitleTick = newValue
        }
        .onReceive(bridgeStore.$overviewVersion) { newValue in
            guard newValue != bridgeOverviewTick else { return }
            if AppMenuTrackingGate.shared.isTrackingMenu {
                pendingBridgeOverviewTick = newValue
                return
            }
            bridgeOverviewTick = newValue
        }
        .onReceive(AppMenuTrackingGate.shared.trackingEnded) { _ in
            if let pending = pendingActivityTick,
               pending != activityTick {
                activityTick = pending
            }
            pendingActivityTick = nil

            if let pending = pendingBridgeOverviewTick,
               pending != bridgeOverviewTick {
                bridgeOverviewTick = pending
            }
            pendingBridgeOverviewTick = nil
        }
        .onReceive(TerminalAgentAttentionMuteStore.shared.$version) { newValue in
            guard newValue != attentionMuteTick else { return }
            attentionMuteTick = newValue
        }
        .onReceive(ContextBankStore.shared.$activeRuns) { newRuns in
            // Loop snapshot only filters by the keyset (workspace IDs),
            // so phase/count updates within an existing run don't move
            // the filter. Bumping the tick on those would re-render the
            // panel for nothing.
            let nextKeys = Set(newRuns.map { $0.id })
            guard nextKeys != observedCuratorForkKeys else { return }
            observedCuratorForkKeys = nextKeys
            curatorForkTick &+= 1
        }
    }

    @ViewBuilder
    func collapsedBody(scopedTabs: [Workspace]) -> some View {
        let snapshot = makeActiveAgentsWorkspaceSnapshot(tabs: scopedTabs)
        let currentBranch = currentHeaderBranch(snapshot: snapshot)
        let counts = computePanelCounts(snapshot: snapshot)
        let runningCount = counts.abilitySessions
            + counts.runningTerminals
            + counts.runningBridges
        let waitingCount = counts.waitingTerminals
        let finishedCount = counts.finishedTerminals + counts.finishedBridges
        VStack(spacing: 0) {
            TermLoopSidebarRule()
            LazyVStack(alignment: .leading, spacing: 4) {
                header(
                    currentBranch: currentBranch,
                    runningCount: runningCount,
                    waitingCount: waitingCount,
                    finishedCount: finishedCount,
                    resumeCwdsProvider: { resumeCwds(tabs: scopedTabs) }
                )
            }
            .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    func expandedBody(scopedTabs: [Workspace]) -> some View {
        let renderSnapshot = expandedRenderMemo.value(
            for: ActiveAgentsExpandedRenderSignature(
                workspaceIds: scopedTabs.map(\.id),
                workspaceTitles: workspaceTitleSignatures(for: scopedTabs),
                selectedTabId: tabManager.selectedTabId,
                agentSessionTick: agentSessionTick,
                projectScopeTick: projectScopeTick,
                activityTick: activityTick,
                bridgeOverviewTick: bridgeOverviewTick,
                branchTick: branchTick,
                attentionMuteTick: attentionMuteTick
            )
        ) {
            makeActiveAgentsExpandedRenderSnapshot(tabs: scopedTabs)
        }
        let effectiveSelectionTarget = effectiveSelectionTarget(from: renderSnapshot.allTargets)

        VStack(spacing: 0) {
            TermLoopSidebarRule()
            expandedHeader(renderSnapshot)
                .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                .padding(.top, 6)
                .padding(.bottom, renderSnapshot.hasAny ? 2 : 6)
            if !renderSnapshot.hasAny {
                emptyPlaceholder
                    .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                    .padding(.bottom, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ResizableSidebarPanelContainer(
                    storageKey: AgentSidebarPanelLayoutState.activeLoopHeightKey,
                    mediumHeight: 220,
                    minHeight: 72
                ) {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        terminalAndBridgeRows(renderSnapshot, selection: effectiveSelectionTarget)
                        orphanBridgeRows(renderSnapshot, selection: effectiveSelectionTarget)
                        abilityRows(renderSnapshot, selection: effectiveSelectionTarget)
                    }
                    .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                    .padding(.top, 2)
                    .padding(.bottom, 6)
                }
            }
        }
    }

    @ViewBuilder
    func expandedHeader(_ renderSnapshot: ActiveAgentsExpandedRenderSnapshot) -> some View {
        header(
            currentBranch: currentHeaderBranch(snapshot: renderSnapshot.workspaceSnapshot),
            runningCount: renderSnapshot.runningCount,
            waitingCount: renderSnapshot.waitingCount,
            finishedCount: renderSnapshot.finishedCount,
            resumeCwdsProvider: { resumeCwds(tabs: renderSnapshot.workspaceSnapshot.tabs) }
        )
    }

    @ViewBuilder
    func terminalAndBridgeRows(
        _ renderSnapshot: ActiveAgentsExpandedRenderSnapshot,
        selection: ActiveAgentsNavigationTarget?
    ) -> some View {
        ForEach(renderSnapshot.terminalSessions) { session in
            terminalSessionRow(
                session,
                branchSummary: cachedBranchSummary(
                    for: session.core.workspaceId,
                    cache: renderSnapshot.branchSummaryByWorkspaceId
                ),
                isSelected: selection == .terminal(session.core.workspaceId),
                contextMenuSnapshot: renderSnapshot.contextMenuSnapshotsByWorkspaceId[session.core.workspaceId]
            )
            .equatable()
            ForEach(renderSnapshot.groupedBridges[session.core.workspaceId] ?? [], id: \.id) { bridge in
                bridgeRow(
                    bridge,
                    workspaceById: renderSnapshot.workspaceSnapshot.workspaceById,
                    isSelected: selection == .bridge(bridge.id)
                )
            }
        }
    }

    @ViewBuilder
    func orphanBridgeRows(
        _ renderSnapshot: ActiveAgentsExpandedRenderSnapshot,
        selection: ActiveAgentsNavigationTarget?
    ) -> some View {
        ForEach(renderSnapshot.orphanBridges, id: \.id) { bridge in
            bridgeRow(
                bridge,
                workspaceById: renderSnapshot.workspaceSnapshot.workspaceById,
                isSelected: selection == .bridge(bridge.id)
            )
        }
    }

    @ViewBuilder
    func abilityRows(
        _ renderSnapshot: ActiveAgentsExpandedRenderSnapshot,
        selection: ActiveAgentsNavigationTarget?
    ) -> some View {
        ForEach(renderSnapshot.sessions) { session in
            abilityRow(
                session,
                branchSummary: cachedBranchSummary(
                    for: session.workspaceId,
                    cache: renderSnapshot.branchSummaryByWorkspaceId
                ),
                isSelected: selection == .ability(session.workspaceId),
                contextMenuSnapshot: renderSnapshot.contextMenuSnapshotsByWorkspaceId[session.workspaceId]
            )
            .equatable()
        }
    }

    func header(
        currentBranch: String?,
        runningCount: Int,
        waitingCount: Int,
        finishedCount: Int,
        resumeCwdsProvider: @escaping () -> [String]
    ) -> some View {
        ActiveAgentsHeaderView(
            isCollapsed: $isCollapsed,
            isHidden: $isHidden,
            isResumePopoverPresented: $isResumePopoverPresented,
            currentBranch: currentBranch,
            runningCount: runningCount,
            waitingCount: waitingCount,
            finishedCount: finishedCount,
            resumeCwdsProvider: resumeCwdsProvider
        )
    }

    var emptyPlaceholder: some View {
        Text(String(
            localized: "agents.panel.noActive",
            defaultValue: "No active agents",
            table: "TermLoop"
        ))
        .font(TermLoopSidebarTheme.tinyMono)
        .foregroundStyle(TermLoopSidebarTheme.dimmer)
    }
}
