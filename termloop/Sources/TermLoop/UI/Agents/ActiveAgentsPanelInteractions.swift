// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Bonsplit
import SwiftUI

extension ActiveAgentsPanel {
    func abilityRow(
        _ session: AbilityAgentSession,
        branchSummary: String?,
        isSelected: Bool,
        contextMenuSnapshot: ActiveAgentWorkspaceContextMenuSnapshot?
    ) -> AbilityAgentRow {
        AbilityAgentRow(
            session: session,
            branchSummary: branchSummary,
            isSelected: isSelected,
            tabManager: tabManager,
            contextMenuSnapshot: contextMenuSnapshot,
            onTap: { [weak tabManager] in
                focusPanel(on: .ability(session.workspaceId))
                #if DEBUG
                dlog("ActiveAgentsPanel.abilityRow tap workspaceId=\(session.workspaceId.uuidString.prefix(8))")
                #endif
                if let abilityId = session.kind.abilityId {
                    MainAreaActivation.activateAbilityWorkspaceTerminal(
                        session.workspaceId,
                        abilityId: abilityId,
                        on: tabManager
                    )
                } else {
                    MainAreaActivation.activateWorkspaceTerminal(session.workspaceId, on: tabManager)
                }
            },
            onClose: { [weak tabManager] in
                guard let tm = tabManager,
                      let ws = tm.tabs.first(where: { $0.id == session.workspaceId }) else {
                    return
                }
                _ = tm.closeWorkspaceWithConfirmation(ws)
            },
            onCollapse: { [weak tabManager] in
                guard let tm = tabManager,
                      let ws = tm.tabs.first(where: { $0.id == session.workspaceId }) else {
                    return
                }
                _ = WorkspaceHideCoordinator.confirmAndCollapse(
                    workspace: ws,
                    tabManager: tm,
                    targetName: nil
                )
            },
            elapsedLabel: elapsedLabel(since:)
        )
    }

    func terminalSessionRow(
        _ session: TerminalAgentLiveSession,
        branchSummary: String?,
        isSelected: Bool,
        contextMenuSnapshot: ActiveAgentWorkspaceContextMenuSnapshot?
    ) -> TerminalAgentActivityRow {
        TerminalAgentActivityRow(
            session: session,
            branchSummary: branchSummary,
            isSelected: isSelected,
            tabManager: tabManager,
            contextMenuSnapshot: contextMenuSnapshot,
            onTap: { [weak tabManager] in
                focusPanel(on: .terminal(session.core.workspaceId))
                MainAreaActivation.activateWorkspaceTerminal(session.core.workspaceId, on: tabManager)
            },
            onCloseWorkspace: { [weak tabManager] in
                guard let tm = tabManager,
                      let ws = tm.tabs.first(where: { $0.id == session.core.workspaceId }) else { return }
                tm.closeWorkspaceFromSidebarPopover(ws)
            },
            onCollapseWorkspace: { [weak tabManager] in
                guard let tm = tabManager,
                      let ws = tm.tabs.first(where: { $0.id == session.core.workspaceId }) else { return }
                _ = WorkspaceHideCoordinator.confirmAndCollapse(
                    workspace: ws,
                    tabManager: tm,
                    targetName: session.core.title
                )
            }
        )
    }

    func bridgeRow(
        _ bridge: WorkspaceBridge,
        workspaceById: [UUID: Workspace],
        isSelected: Bool
    ) -> ActiveBridgeRow {
        ActiveBridgeRow(
            bridge: bridge,
            sourceTitle: bridgeSourceTitle(bridge, workspaceById: workspaceById),
            rightWorkspaceTitle: bridgeRightTitle(bridge, workspaceById: workspaceById),
            isSelected: isSelected,
            tabManager: tabManager,
            onSelectLeft: { [weak tabManager] in
                focusPanel(on: .bridge(bridge.id))
                MainAreaActivation.activateWorkspaceTerminal(bridge.leftWorkspaceId, on: tabManager)
            }
        )
    }

    func navigationTargets(
        terminalSessions: [TerminalAgentLiveSession],
        groupedBridges: [UUID: [WorkspaceBridge]],
        orphanBridges: [WorkspaceBridge],
        sessions: [AbilityAgentSession]
    ) -> [ActiveAgentsNavigationTarget] {
        var targets: [ActiveAgentsNavigationTarget] = []
        for session in terminalSessions {
            targets.append(.terminal(session.core.workspaceId))
            targets.append(contentsOf: (groupedBridges[session.core.workspaceId] ?? []).map { .bridge($0.id) })
        }
        targets.append(contentsOf: orphanBridges.map { .bridge($0.id) })
        targets.append(contentsOf: sessions.map { .ability($0.workspaceId) })
        return targets
    }

    func effectiveSelectionTarget(from availableTargets: [ActiveAgentsNavigationTarget]) -> ActiveAgentsNavigationTarget? {
        let selectedTabId = tabManager.selectedTabId
        // Only honor keyboardSelectedTarget when it still represents the active
        // tab. Otherwise a click in another panel (Merged PRs, Worktree Agents)
        // moves selectedTabId but leaves the stale Active Agents row lit up.
        if let keyboardSelectedTarget,
           availableTargets.contains(keyboardSelectedTarget),
           targetMatchesSelectedTab(keyboardSelectedTarget, selectedTabId: selectedTabId) {
            return keyboardSelectedTarget
        }
        guard let selectedTabId else { return nil }
        for candidate in availableTargets {
            switch candidate {
            case .terminal(let id), .ability(let id):
                if id == selectedTabId {
                    return candidate
                }
            case .bridge(let id):
                // Bridge row represents the whole pair; light up when either
                // endpoint is the active tab. Without the right-side check
                // clicking the row (which selects the helper workspace)
                // leaves the row unhighlighted.
                if let bridge = bridgeStore.bridges.first(where: { $0.id == id }),
                   bridge.leftWorkspaceId == selectedTabId || bridge.rightWorkspaceId == selectedTabId {
                    return candidate
                }
            }
        }
        return nil
    }

    private func targetMatchesSelectedTab(
        _ target: ActiveAgentsNavigationTarget,
        selectedTabId: UUID?
    ) -> Bool {
        guard let selectedTabId else { return false }
        switch target {
        case .terminal(let id), .ability(let id):
            return id == selectedTabId
        case .bridge(let id):
            guard let bridge = bridgeStore.bridges.first(where: { $0.id == id }) else { return false }
            return bridge.leftWorkspaceId == selectedTabId || bridge.rightWorkspaceId == selectedTabId
        }
    }

    func focusPanel(on target: ActiveAgentsNavigationTarget) {
        keyboardSelectedTarget = target
    }
}
