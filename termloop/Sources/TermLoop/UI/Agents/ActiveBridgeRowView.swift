// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

@MainActor
struct ActiveBridgeRow: View {
    let bridge: WorkspaceBridge
    let sourceTitle: String
    let rightWorkspaceTitle: String
    let isSelected: Bool
    let tabManager: TabManager
    let onSelectLeft: () -> Void

    private let store = WorkspaceBridgeStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared
    @State private var isExpanded = false
    /// Narrow subscription: we only care about membership + state changes
    /// (pause/resume/stop/add/dismiss). Transcript message appends mutate
    /// `store.bridges` but do not bump `overviewVersion`; subscribing via
    /// `@ObservedObject` would re-render the whole row on every turn.
    @State private var overviewTick: Int = 0

    private var liveBridge: WorkspaceBridge {
        store.bridge(id: bridge.id) ?? bridge
    }

    var body: some View {
        let _ = overviewTick
        let bridge = liveBridge
        let rightWorkspace = tabManager.tabs.first(where: { $0.id == bridge.rightWorkspaceId })
        let snapshot = BridgeTargetRowSnapshotBuilder.build(
            bridge: bridge,
            rightTitle: rightWorkspaceTitle,
            rightWorkspace: rightWorkspace
        )
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("from \(sourceTitle)")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dimmer)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 1)

            BridgeCableView(
                bridge: bridge,
                rightWorkspaceTitle: rightWorkspaceTitle,
                isExpanded: $isExpanded,
                onForward: { sender in
                    BridgeCoordinator.shared.forwardLatestMessage(from: sender, in: bridge)
                },
                onStop: {
                    store.stop(id: bridge.id, reason: .manual)
                    BridgeCoordinator.shared.stop(bridgeId: bridge.id)
                },
                onDismiss: {
                    BridgeCoordinator.shared.dismiss(bridgeId: bridge.id)
                },
                onJumpToRight: {
                    if rightWorkspace != nil {
                        MainAreaActivation.activateWorkspaceTerminal(bridge.rightWorkspaceId, on: tabManager)
                    }
                },
                onSetForwardMode: { mode in
                    BridgeCoordinator.shared.setForwardMode(bridgeId: bridge.id, mode: mode)
                }
            )
            .padding(.leading, 10)

            AgentRowCoreView(
                core: snapshot,
                isSelected: isSelected,
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
            .padding(.leading, 26)

            if isExpanded {
                InlineBridgeTranscript(bridgeId: bridge.id)
                    .padding(.leading, 26)
                    .padding(.top, 4)
            }
        }
        .padding(.vertical, 4)
        .onReceive(store.$overviewVersion) { newValue in
            guard newValue != overviewTick else { return }
            overviewTick = newValue
        }
    }
}
