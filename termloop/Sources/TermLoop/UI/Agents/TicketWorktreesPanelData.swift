// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

extension TicketWorktreesPanel {
    func projectScopedTabs() -> [Workspace] {
        TermLoopSidebar.projectScopedTabs(allTabs: tabManager.tabs)
    }

    func branch(for workspace: Workspace) -> String? {
        let raw = WorkspaceMetadataStore.shared.branch(for: workspace)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? nil : raw
    }

    func assignedTicket(for workspace: Workspace) -> WorkspaceMetadataStore.AssignedTicket? {
        guard let ticket = WorkspaceMetadataStore.shared.assignedTicket(for: workspace) else {
            return nil
        }
        let key = ticket.key.trimmingCharacters(in: .whitespacesAndNewlines)
        let provider = ticket.providerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, !provider.isEmpty else { return nil }
        let normalizedTitle = ticket.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        return WorkspaceMetadataStore.AssignedTicket(
            providerName: provider,
            key: key,
            title: (normalizedTitle?.isEmpty ?? true) ? nil : normalizedTitle
        )
    }

    func buildRenderSnapshot() -> TicketWorktreesRenderSnapshot {
        PanelRenderInstrumentation.measure(.ticketWorktrees) {
            buildRenderSnapshotCore()
        }
    }

    private func buildRenderSnapshotCore() -> TicketWorktreesRenderSnapshot {
        let grouped = buildGrouping()
        let selectedId = tabManager.selectedTabId
        var totalCount = 0
        let groupSnapshots: [TicketGroupSnapshot] = grouped.groups.map { group in
            totalCount += group.workspaces.count
            let rows = group.workspaces.map { workspace -> TicketWorkspaceRowSnapshot in
                let core = AgentRowSnapshotBuilder.build(
                    workspace: workspace,
                    branchLabel: grouped.branchByWorkspaceId[workspace.id],
                    policy: .livePreferred
                )
                return TicketWorkspaceRowSnapshot(
                    core: core,
                    isSelected: selectedId == workspace.id
                )
            }
            return TicketGroupSnapshot(group: group, rows: rows)
        }
        return TicketWorktreesRenderSnapshot(groups: groupSnapshots, totalWorkspaceCount: totalCount)
    }

    func toggleExpanded(ticketID: String) {
        var set = Set(expandedTicketsRaw.split(separator: "\n").map(String.init))
        if set.remove(ticketID) == nil {
            set.insert(ticketID)
        }
        expandedTicketsRaw = set.sorted().joined(separator: "\n")
    }

    func worktreePath(for group: Group) -> String? {
        for workspace in group.workspaces {
            let dir = (workspace.termLoopPresentationCwd() ?? workspace.currentDirectory)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !dir.isEmpty { return (dir as NSString).abbreviatingWithTildeInPath }
        }
        return nil
    }

    private struct Grouping {
        let groups: [Group]
        let branchByWorkspaceId: [UUID: String]
    }

    private func buildGrouping() -> Grouping {
        var buckets: [String: (ticket: WorkspaceMetadataStore.AssignedTicket, workspaces: [Workspace])] = [:]
        var order: [String] = []
        var branchByWorkspaceId: [UUID: String] = [:]

        for workspace in projectScopedTabs() {
            guard let branch = branch(for: workspace),
                  let ticket = assignedTicket(for: workspace) else { continue }
            branchByWorkspaceId[workspace.id] = branch
            let id = Group.groupID(for: ticket)
            if buckets[id] == nil {
                buckets[id] = (ticket, [])
                order.append(id)
            }
            buckets[id]?.workspaces.append(workspace)
        }

        let groups = order.compactMap { id in
            buckets[id].map { Group(ticket: $0.ticket, workspaces: $0.workspaces) }
        }
        return Grouping(groups: groups, branchByWorkspaceId: branchByWorkspaceId)
    }
}
