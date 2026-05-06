// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Bonsplit
import Combine
import SwiftUI

enum ActiveAgentsPanelState {
    static let hiddenKey = "termloop.activeAgents.hidden.v1"
}

/// AppKit invalidates hover tracking for nested `NSMenu` items if the SwiftUI
/// view that owns the context menu is rebuilt while the menu is open. Agent
/// rows can receive many live activity updates during a turn, so panels use
/// this gate to defer non-essential row refreshes until menu tracking ends.
final class AppMenuTrackingGate {
    static let shared = AppMenuTrackingGate()

    let trackingEnded = PassthroughSubject<Void, Never>()

    private(set) var isTrackingMenu = false

    private var trackingDepth = 0
    private var endGeneration = 0
    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: NSMenu.didBeginTrackingNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.beginTracking()
        })
        observers.append(center.addObserver(
            forName: NSMenu.didEndTrackingNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.endTracking()
        })
    }

    deinit {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    private func beginTracking() {
        trackingDepth += 1
        isTrackingMenu = true
        endGeneration &+= 1
    }

    private func endTracking() {
        if trackingDepth > 0 {
            trackingDepth -= 1
        }
        guard trackingDepth == 0 else { return }

        endGeneration &+= 1
        let generation = endGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self,
                  self.trackingDepth == 0,
                  self.endGeneration == generation else { return }
            self.isTrackingMenu = false
            self.trackingEnded.send(())
        }
    }
}

@MainActor
struct ActiveAgentsPanel: View {
    struct BranchObservationKey: Equatable {
        let workspaceId: UUID
        let branch: String?
    }

    @EnvironmentObject var tabManager: TabManager
    let bridgeStore = WorkspaceBridgeStore.shared

    @State var agentSessionTick: Int = 0
    @State var projectScopeTick: Int = 0
    @State var activityTick: Int = 0
    @State var bridgeOverviewTick: Int = 0
    @State var pendingActivityTick: Int?
    @State var pendingBridgeOverviewTick: Int?
    @State var branchTick: Int = 0
    @State var attentionMuteTick: Int = 0
    @State var workspaceTitleTick: Int = 0
    /// Re-render trigger for `ContextBankStore.activeRuns` changes. The
    /// Loop snapshot filter reads `activeCuratorForkWorkspaceIds`; without
    /// this tick a brand-new curator fork would leak into the Loop tab
    /// until the next unrelated snapshot rebuild.
    @State var curatorForkTick: Int = 0
    /// Tracked keyset for `ContextBankStore.activeRuns` so we only bump
    /// `curatorForkTick` when the workspace-id set actually changes —
    /// phase/count updates within an existing run don't move the Loop
    /// filter and don't deserve a panel re-render.
    @State var observedCuratorForkKeys: Set<UUID> = []
    @State var expandedRenderMemo = ActiveAgentsExpandedRenderMemo()
    @State var branchSummaryMemo = ActiveAgentsBranchSummaryMemo()
    @State var observedBranchKeys: [BranchObservationKey] = []

    let attentionMute = TerminalAgentAttentionMuteStore.shared
    @ObservedObject var projectStore = ProjectStore.shared

    @AppStorage("termloop.activeAgents.collapsed.v2") var isCollapsed: Bool = true
    @AppStorage(ActiveAgentsPanelState.hiddenKey) var isHidden: Bool = false
    @State var keyboardSelectedTarget: ActiveAgentsNavigationTarget?

    @State var isResumePopoverPresented: Bool = false
}

enum ActiveAgentsPanelTypography {
    static let headerLabel: Font = .system(size: 13, weight: .semibold, design: .monospaced)
}

@MainActor
struct ActiveAgentsHiddenRow: View {
    @AppStorage(ActiveAgentsPanelState.hiddenKey) private var isHidden: Bool = false

    var body: some View {
        if isHidden {
            VStack(spacing: 0) {
                TermLoopSidebarRule()
                Button {
                    isHidden = false
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.up")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .frame(width: 10)
                        Circle()
                            .fill(TermLoopSidebarTheme.dim)
                            .frame(width: 6, height: 6)
                        Text(TermLoopSidebarTheme.adaptiveSectionTitle(String(
                            localized: "agents.panel.title",
                            defaultValue: "Active Agents",
                            table: "TermLoop"
                        )))
                        .font(TermLoopSidebarTheme.adaptiveSectionFont(size: 11))
                        .foregroundStyle(TermLoopSidebarTheme.adaptiveSectionColor)
                        Spacer()
                        Text(String(
                            localized: "agents.panel.hidden.restore",
                            defaultValue: "restore",
                            table: "TermLoop"
                        ))
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                    }
                    .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(String(
                    localized: "agents.panel.hidden.help",
                    defaultValue: "Click to restore Active Agents",
                    table: "TermLoop"
                ))
            }
            .frame(maxWidth: .infinity)
        }
    }
}

@MainActor
struct ActiveAgentsHeaderView: View {
    @Binding var isCollapsed: Bool
    @Binding var isHidden: Bool
    @Binding var isResumePopoverPresented: Bool

    let currentBranch: String?
    let runningCount: Int
    let waitingCount: Int
    let finishedCount: Int
    let resumeCwdsProvider: () -> [String]

    private var hasRunning: Bool { runningCount > 0 }
    private var hasWaiting: Bool { waitingCount > 0 }
    private var hasFinished: Bool { finishedCount > 0 }

    private var indicatorColor: Color {
        if hasRunning { return TermLoopSidebarTheme.stateRunning }
        if hasWaiting { return TermLoopSidebarTheme.stateNeedsInput }
        if hasFinished { return TermLoopSidebarTheme.stateCompleted }
        return Color.gray.opacity(0.4)
    }

    private var counterColor: Color {
        if hasRunning { return TermLoopSidebarTheme.stateRunning }
        if hasWaiting { return TermLoopSidebarTheme.stateNeedsInput }
        if hasFinished { return TermLoopSidebarTheme.stateCompleted }
        return TermLoopSidebarTheme.dimmer
    }

    private var counterText: String {
        if hasRunning && hasWaiting { return "\(runningCount)+\(waitingCount)" }
        if hasRunning && hasFinished { return "\(runningCount)+\(finishedCount)✓" }
        if hasWaiting && hasFinished { return "\(waitingCount)+\(finishedCount)✓" }
        if hasRunning { return "\(runningCount)" }
        if hasWaiting { return "\(waitingCount)" }
        if hasFinished { return "\(finishedCount)✓" }
        return "0"
    }

    var body: some View {
        HStack(spacing: 6) {
            Button {
                isCollapsed.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 10)
                    Circle()
                        .fill(indicatorColor)
                        .frame(width: 6, height: 6)
                    Text(TermLoopSidebarTheme.adaptiveSectionTitle(String(
                        localized: "agents.panel.title",
                        defaultValue: "Active Agents",
                        table: "TermLoop"
                    )))
                    .font(TermLoopSidebarTheme.adaptiveSectionFont(size: 11))
                    .foregroundStyle(TermLoopSidebarTheme.adaptiveSectionColor)
                    if let currentBranch,
                       !currentBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(verbatim: currentBranch)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Spacer()
            Text(verbatim: counterText)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(counterColor)
                .monospacedDigit()
            AgentSidebarPanelSizeCycleButton(
                storageKey: AgentSidebarPanelLayoutState.activeLoopHeightKey,
                mediumHeight: 220
            )
            SessionResumeButton(
                cwdsProvider: resumeCwdsProvider,
                isPresented: $isResumePopoverPresented
            )
            Button {
                isHidden = true
            } label: {
                Image(systemName: "eye.slash")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .frame(width: 14, height: 14)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(String(
                localized: "agents.panel.hide.help",
                defaultValue: "Hide to footer row",
                table: "TermLoop"
            ))
        }
        .help(String(
            localized: "agents.panel.toggleCollapse.help",
            defaultValue: "Click to expand/collapse",
            table: "TermLoop"
        ))
    }
}
