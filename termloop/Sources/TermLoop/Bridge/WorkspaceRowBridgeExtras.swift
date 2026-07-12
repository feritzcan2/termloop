// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

// termloop/Sources/TermLoop/Bridge/WorkspaceRowBridgeExtras.swift
import SwiftUI

/// Rendered directly after the LEFT endpoint of a bridge. The cable is anchored
/// below the left workspace row even when the right workspace is elsewhere in
/// the list or in a collapsed project section; the cable badge carries a "↦
/// <right title>" jump affordance so navigation still works. Draws nothing for
/// workspaces not in a bridge or for the RIGHT endpoint (the cable is drawn
/// once, under the LEFT side).
@MainActor
struct WorkspaceRowBridgeExtras: View {
    let workspace: Workspace
    let tabManager: TabManager
    private let store = WorkspaceBridgeStore.shared
    /// Narrow activity subscription: the right-endpoint row below reads through
    /// `BridgeTargetRowSnapshotBuilder` → `TerminalAgentActivityStore`. Without
    /// this, reported-link/preview/since updates on the right workspace would
    /// not repaint the row. `presentationVersion` is coalesced, so frequency is
    /// safe.
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared
    @State private var expandedBridges: Set<UUID> = []
    @State private var overviewTick: Int = 0

    var body: some View {
        let _ = overviewTick
        Group {
            if let bridge = eligibleBridge() {
                let rightWorkspace = tabManager.tabs.first(where: { $0.id == bridge.rightWorkspaceId })
                let right = rightTitle(for: bridge, rightWorkspace: rightWorkspace)
                VStack(spacing: 0) {
                    BridgeCableView(
                        bridge: bridge,
                        rightWorkspaceTitle: right,
                        isExpanded: binding(for: bridge.id),
                        onForward: { sender in
                            BridgeCoordinator.shared.forwardLatestMessage(from: sender, in: bridge)
                        },
                        onStop: { BridgeCoordinator.shared.stop(bridgeId: bridge.id) },
                        onDismiss: { BridgeCoordinator.shared.dismiss(bridgeId: bridge.id) },
                        onJumpToRight: {
                            if rightWorkspace != nil {
                                MainAreaActivation.activateWorkspaceTerminal(bridge.rightWorkspaceId, on: tabManager)
                            }
                        },
                        onSetForwardMode: { mode in
                            BridgeCoordinator.shared.setForwardMode(bridgeId: bridge.id, mode: mode)
                        }
                    )
                    if shouldAttachRightRow(for: bridge) {
                        AgentRowCoreView(
                            core: BridgeTargetRowSnapshotBuilder.build(
                                bridge: bridge,
                                rightTitle: right,
                                rightWorkspace: rightWorkspace
                            ),
                            isSelected: false,
                            trailingSlot: .none,
                            dismissBehavior: .confirmClose(onConfirm: {
                                BridgeCoordinator.shared.dismissAndCloseRight(bridgeId: bridge.id)
                            }),
                            onActivate: {
                                if rightWorkspace != nil {
                                    MainAreaActivation.activateWorkspaceTerminal(bridge.rightWorkspaceId, on: tabManager)
                                }
                            },
                            onTrailingSlotTap: nil
                        )
                        .equatable()
                        .padding(.leading, 28)
                        .padding(.bottom, 2)
                    }
                    if expandedBridges.contains(bridge.id) {
                        InlineBridgeTranscript(bridgeId: bridge.id)
                            .padding(.leading, 28)
                    }
                }
            }
        }
        .onReceive(store.$overviewVersion) { newValue in
            guard newValue != overviewTick else { return }
            overviewTick = newValue
        }
    }

    private func eligibleBridge() -> WorkspaceBridge? {
        guard let bridge = store.bridge(forWorkspaceId: workspace.id),
              bridge.leftWorkspaceId == workspace.id
        else { return nil }
        return bridge
    }

    private func rightTitle(for bridge: WorkspaceBridge, rightWorkspace: Workspace?) -> String {
        if let override = bridge.rightWorkspaceTitleOverride?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty() {
            return override
        }
        guard let ws = rightWorkspace else { return "?" }
        return ws.customTitle?.trimmingCharacters(in: .whitespaces).nilIfEmpty() ?? ws.title
    }

    private func shouldAttachRightRow(for bridge: WorkspaceBridge) -> Bool {
        bridge.intent == .askAgent
            || WorkspaceMetadataStore.shared.isHiddenFromWorkspaceTree(workspaceId: bridge.rightWorkspaceId)
    }

    private func binding(for id: UUID) -> Binding<Bool> {
        Binding(
            get: { expandedBridges.contains(id) },
            set: { newValue in
                if newValue { expandedBridges.insert(id) }
                else { expandedBridges.remove(id) }
            }
        )
    }
}

private extension String {
    func nilIfEmpty() -> String? { isEmpty ? nil : self }
}
