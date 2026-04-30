// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct TicketWorkspaceRowSnapshot: Equatable {
    let core: AgentRowPresentationSnapshot
    let isSelected: Bool
}

extension TicketWorktreesPanel {
    func header(ticketCount: Int, workspaceCount: Int) -> some View {
        HStack(spacing: 6) {
            Button {
                isCollapsed.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 10)
                    Image(systemName: "ticket.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 12, height: 12)
                    Text(TermLoopSidebarTheme.caps(String(
                        localized: "ticketWorktrees.panel.title",
                        defaultValue: "Tickets",
                        table: "TermLoop"
                    )))
                    .font(TermLoopSidebarTheme.headerLabel)
                    .foregroundStyle(Color.primary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Spacer()
            Text(verbatim: "\(ticketCount)·\(workspaceCount)")
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .monospacedDigit()
            AgentSidebarPanelSizeCycleButton(
                storageKey: AgentSidebarPanelLayoutState.ticketHeightKey,
                mediumHeight: 180
            )
        }
        .help(String(
            localized: "ticketWorktrees.panel.toggleCollapse.help",
            defaultValue: "Click to expand/collapse",
            table: "TermLoop"
        ))
    }

    @ViewBuilder
    func ticketGroupView(_ snapshot: TicketGroupSnapshot, isExpanded expanded: Bool) -> some View {
        let group = snapshot.group
        let path = worktreePath(for: group)
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .frame(width: 10)
                    .padding(.top, 2)
                Image(systemName: "tag.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .frame(width: 10, height: 10)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Text(group.ticket.key)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(group.ticket.providerName.uppercased())
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .lineLimit(1)
                    }
                    if let title = group.ticket.title, !title.isEmpty {
                        Text(title)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .lineLimit(2)
                    }
                    if let path {
                        Text(path)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dimmer)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(path)
                    }
                }
                Spacer()
                Text(verbatim: "\(snapshot.rows.count)")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .monospacedDigit()
                    .padding(.top, 2)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
            .onTapGesture { toggleExpanded(ticketID: group.id) }

            if expanded {
                VStack(spacing: 1) {
                    ForEach(snapshot.rows, id: \.core.workspaceId) { rowSnapshot in
                        workspaceRow(rowSnapshot: rowSnapshot)
                    }
                }
                .padding(.leading, 18)
            }
        }
    }

    @ViewBuilder
    func workspaceRow(rowSnapshot: TicketWorkspaceRowSnapshot) -> some View {
        let workspaceId = rowSnapshot.core.workspaceId
        let tabManager = self.tabManager
        AgentRowCoreView(
            core: rowSnapshot.core,
            isSelected: rowSnapshot.isSelected,
            trailingSlot: .none,
            dismissBehavior: .none,
            onActivate: { MainAreaActivation.activateWorkspaceTerminal(workspaceId, on: tabManager) },
            onAcknowledgeAttention: {
                TerminalAgentActivityStore.shared.acknowledgeViewedAttention(forWorkspaceId: workspaceId)
            },
            onTrailingSlotTap: nil
        )
        .equatable()
        .contextMenu {
            if let snapshot = ActiveAgentWorkspaceContextMenuSnapshot.build(
                workspaceId: workspaceId,
                tabs: tabManager.tabs
            ) {
                ActiveAgentWorkspaceContextMenu(
                    snapshot: snapshot,
                    tabManager: tabManager
                )
            }
        }
    }
}
