// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

enum TicketWorktreesPanelState {
    static let collapsedKey = "termloop.ticketWorktrees.collapsed.v1"
    static let expandedTicketsKey = "termloop.ticketWorktrees.expandedTickets.v1"

    static func reveal(ticketID: String, defaults: UserDefaults = .standard) {
        let trimmedID = ticketID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedID.isEmpty else { return }

        defaults.set(false, forKey: collapsedKey)

        var expandedTickets = Set(
            (defaults.string(forKey: expandedTicketsKey) ?? "")
                .split(separator: "\n")
                .map(String.init)
        )
        expandedTickets.insert(trimmedID)
        defaults.set(expandedTickets.sorted().joined(separator: "\n"), forKey: expandedTicketsKey)
    }
}

struct TicketWorktreesRenderSignature: Equatable {
    let workspaceIds: [UUID]
    let selectedTabId: UUID?
    let branchTick: Int
    let ticketBindingTick: Int
    let agentSessionTick: Int
    let projectScopeTick: Int
    let activityTick: Int
}

struct TicketGroupSnapshot: Identifiable {
    let group: TicketWorktreesPanel.Group
    let rows: [TicketWorkspaceRowSnapshot]

    var id: String { group.id }
}

struct TicketWorktreesRenderSnapshot {
    let groups: [TicketGroupSnapshot]
    let totalWorkspaceCount: Int
}

@MainActor
final class TicketWorktreesRenderMemo {
    private var signature: TicketWorktreesRenderSignature?
    private var cache: TicketWorktreesRenderSnapshot?

    func value(
        for signature: TicketWorktreesRenderSignature,
        build: () -> TicketWorktreesRenderSnapshot
    ) -> TicketWorktreesRenderSnapshot {
        if self.signature == signature, let cache {
            return cache
        }
        let next = build()
        self.signature = signature
        self.cache = next
        return next
    }
}

@MainActor
struct TicketWorktreesPanel: View {
    @EnvironmentObject var tabManager: TabManager
    @ObservedObject var projectStore = ProjectStore.shared

    @State var branchTick: Int = 0
    @State var ticketBindingTick: Int = 0
    @State var agentSessionTick: Int = 0
    @State var projectScopeTick: Int = 0
    @State var activityTick: Int = 0
    @State var renderMemo = TicketWorktreesRenderMemo()

    @AppStorage(TicketWorktreesPanelState.collapsedKey) var isCollapsed: Bool = false
    @AppStorage(TicketWorktreesPanelState.expandedTicketsKey) var expandedTicketsRaw: String = ""

    struct Group: Identifiable {
        let ticket: WorkspaceMetadataStore.AssignedTicket
        let workspaces: [Workspace]

        var id: String { Group.groupID(for: ticket) }

        static func groupID(for ticket: WorkspaceMetadataStore.AssignedTicket) -> String {
            let provider = ticket.providerName.trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(provider)::\(ticket.key)"
        }
    }

    var body: some View {
        let scopedTabs = projectScopedTabs()
        let _ = projectScopeTick
        let render = renderMemo.value(
            for: TicketWorktreesRenderSignature(
                workspaceIds: scopedTabs.map(\.id),
                selectedTabId: tabManager.selectedTabId,
                branchTick: branchTick,
                ticketBindingTick: ticketBindingTick,
                agentSessionTick: agentSessionTick,
                projectScopeTick: projectScopeTick,
                activityTick: activityTick
            )
        ) {
            buildRenderSnapshot()
        }
        let expandedIDs = Set(expandedTicketsRaw.split(separator: "\n").map(String.init))

        return VStack(spacing: 0) {
            if !render.groups.isEmpty {
                TermLoopSidebarRule()
                header(ticketCount: render.groups.count,
                       workspaceCount: render.totalWorkspaceCount)
                    .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                    .padding(.top, 6)
                    .padding(.bottom, isCollapsed ? 6 : 2)
                if !isCollapsed {
                    ResizableSidebarPanelContainer(
                        storageKey: AgentSidebarPanelLayoutState.ticketHeightKey,
                        mediumHeight: 180,
                        minHeight: 72
                    ) {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(render.groups) { groupSnapshot in
                                ticketGroupView(groupSnapshot, isExpanded: expandedIDs.contains(groupSnapshot.id))
                            }
                        }
                        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                        .padding(.top, 2)
                        .padding(.bottom, 6)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .onReceive(WorkspaceMetadataStore.shared.$branchVersion) { newValue in
            guard newValue != branchTick else { return }
            branchTick = newValue
        }
        .onReceive(WorkspaceMetadataStore.shared.$ticketBindingVersion) { newValue in
            guard newValue != ticketBindingTick else { return }
            ticketBindingTick = newValue
        }
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
            activityTick = newValue
        }
    }
}
