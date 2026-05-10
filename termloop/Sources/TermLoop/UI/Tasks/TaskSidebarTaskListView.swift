// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Default sidebar content on the .tasks tab. Lists tasks grouped by column
/// with a status dot and selection highlight. Tapping a row drills the sidebar
/// into the per-task focus view (TaskSidebarDrillInView).
struct TaskSidebarTaskListView: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var onCreateTask: ((TaskColumnId) -> UUID?)?
    var onCreateRemoteItem: (() -> Void)?
    var isCreateRemoteItemDisabled = false
    var onOpenSettings: () -> Void = {}

    @State private var isArchivedExpanded = false
    @State private var isAllTasksExpanded = false
    @State private var isRemoteItemsTipDismissed = false
    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared
    @EnvironmentObject private var tabManager: TabManager

    var body: some View {
        let statuses = agentStatusesByTaskId
        let workItems = store.settingsSnapshot.remoteSync.isEnabled ? workItemsByTaskId : [:]
        return VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    createButton
                    createRemoteItemButton
                    if isAllTasksExpanded {
                        ForEach(store.columnSnapshots) { col in
                            if !col.cards.isEmpty {
                                section(
                                    title: store.columnTitle(for: col.id),
                                    cards: col.cards,
                                    statuses: statuses,
                                    workItems: workItems
                                )
                            }
                        }
                    }
                }
                .padding(10)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 10) {
                remoteItemsTip
                allTasksDisclosure
                archivedSection(
                    cards: store.archivedSnapshots,
                    workItems: workItems
                )
                TaskSidebarSettingsButton(action: onOpenSettings)
            }
                .padding(10)
                .padding(.top, 1)
                .background(Color(nsColor: .windowBackgroundColor))
        }
    }

    @ViewBuilder
    private var remoteItemsTip: some View {
        if !store.settingsSnapshot.remoteSync.isEnabled && !isRemoteItemsTipDismissed {
            TaskSidebarTipBanner(
                iconSystemName: "point.3.connected.trianglepath.dotted",
                title: String(localized: "tasks.sidebar.remote.tip.title",
                              defaultValue: "Sync remote work items",
                              table: "TermLoop"),
                subtitle: String(localized: "tasks.sidebar.remote.tip.subtitle",
                                 defaultValue: "You can sync this board with Jira, GitHub, or GitLab.",
                                 table: "TermLoop"),
                action: onOpenSettings,
                onDismiss: { isRemoteItemsTipDismissed = true }
            )
        }
    }

    private var activeTaskCount: Int {
        store.columnSnapshots.reduce(0) { total, column in
            total + column.cards.count
        }
    }

    @ViewBuilder
    private var allTasksDisclosure: some View {
        if activeTaskCount > 0 {
            Button {
                withAnimation(.easeInOut(duration: 0.12)) {
                    isAllTasksExpanded.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: isAllTasksExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 10)
                    Text(allTasksDisclosureTitle)
                        .font(.system(size: 12, weight: .medium))
                    Spacer(minLength: 0)
                }
                .foregroundColor(.secondary)
                .padding(.vertical, 7)
                .padding(.horizontal, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private var allTasksDisclosureTitle: String {
        if isAllTasksExpanded {
            return String(localized: "tasks.sidebar.hideAllTasks",
                          defaultValue: "Hide all tasks (\(activeTaskCount))",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.showAllTasks",
                      defaultValue: "Show all tasks (\(activeTaskCount))",
                      table: "TermLoop")
    }

    @ViewBuilder
    private func archivedSection(
        cards: [TaskCardSummary],
        workItems: [UUID: TaskWorkItemSnapshot]
    ) -> some View {
        if !cards.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                Button {
                    withAnimation(.easeInOut(duration: 0.12)) {
                        isArchivedExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isArchivedExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .frame(width: 10)
                        Text(String(localized: "tasks.sidebar.archived",
                                    defaultValue: "Archived", table: "TermLoop"))
                            .font(TermLoopSidebarTheme.adaptiveSectionFont(size: 11))
                            .foregroundStyle(TermLoopSidebarTheme.adaptiveSectionColor)
                        Spacer()
                        Text("\(cards.count)")
                            .font(.system(size: 11, weight: .regular))
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .monospacedDigit()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, 2)

                if isArchivedExpanded {
                    ForEach(cards) { card in
                        row(
                            card,
                            status: nil,
                            workItem: workItems[card.id],
                            isSelectable: false,
                            isArchived: true
                        )
                    }
                }
            }
        }
    }

    private var agentStatusesByTaskId: [UUID: TaskAgentStatusSummary] {
        // Intentional subscription reads: task rows project live agent state
        // without storing agent telemetry in TaskBoardStore.
        _ = metadataStore
        _ = activityStore
        return TaskAgentProjectionBuilder.statusSummaries(
            for: store.fileSnapshot().tasks.filter { $0.archivedAt == nil },
            openWorkspaceIds: Set(tabManager.tabs.map(\.id))
        )
    }

    private var workItemsByTaskId: [UUID: TaskWorkItemSnapshot] {
        // Work item bindings are shared workspace metadata; keep Tasks as a
        // read-only projection so sidebar rows update with that store.
        _ = metadataStore
        return TaskWorkItemProjectionBuilder.snapshots(for: store.fileSnapshot().tasks)
    }

    private func section(
        title: String,
        cards: [TaskCardSummary],
        statuses: [UUID: TaskAgentStatusSummary],
        workItems: [UUID: TaskWorkItemSnapshot]
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(TermLoopSidebarTheme.adaptiveSectionTitle(title))
                    .font(TermLoopSidebarTheme.adaptiveSectionFont(size: 11))
                    .foregroundStyle(TermLoopSidebarTheme.adaptiveSectionColor)
                Spacer()
                Text("\(cards.count)")
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .monospacedDigit()
            }
            ForEach(cards) { card in
                row(card, status: statuses[card.id], workItem: workItems[card.id])
            }
        }
    }

    private func row(
        _ card: TaskCardSummary,
        status: TaskAgentStatusSummary?,
        workItem: TaskWorkItemSnapshot?,
        isSelectable: Bool = true,
        isArchived: Bool = false
    ) -> some View {
        let statusPresentation = TaskStatusPresentation(
            provisionState: card.provisionState,
            agentStatus: status
        )
        let trailingStatus = isArchived
            ? String(localized: "tasks.sidebar.archivedStatus",
                     defaultValue: "Archived", table: "TermLoop")
            : statusPresentation.text
        let statusColor = isArchived ? Color.secondary : statusPresentation.color
        return HStack(alignment: .center, spacing: 7) {
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(rowTitle(card, workItem: workItem))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                Text(rowSubtitle(card))
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            if let workItem {
                Text(workItem.key)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .lineLimit(1)
            }
            Text(trailingStatus)
                .font(.system(size: 10, weight: .regular))
                .foregroundStyle(statusColor)
                .lineLimit(1)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(rowBackground(card))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .opacity(isArchived ? 0.72 : 1)
        .onTapGesture {
            guard isSelectable else { return }
            selection.select(card.id)
        }
    }

    private func rowSubtitle(_ card: TaskCardSummary) -> String {
        if let branch = card.branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty {
            return branch
        }
        if let path = card.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty {
            return URL(fileURLWithPath: path).lastPathComponent
        }
        return String(localized: "tasks.sidebar.row.manualTask",
                      defaultValue: "Manual task", table: "TermLoop")
    }

    private func rowTitle(_ card: TaskCardSummary, workItem: TaskWorkItemSnapshot?) -> String {
        workItem?.title ?? card.title
    }

    private var createButton: some View {
        Button(action: createTask) {
            HStack(spacing: 6) {
                Image(systemName: "plus")
                Text(String(localized: "tasks.sidebar.newTask",
                            defaultValue: "New task", table: "TermLoop"))
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 7)
            .padding(.horizontal, 8)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var createRemoteItemButton: some View {
        if store.settingsSnapshot.remoteSync.isEnabled, let onCreateRemoteItem {
            Button(action: onCreateRemoteItem) {
                HStack(spacing: 7) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 11, weight: .semibold))
                    Text(String(localized: "tasks.sidebar.createRemoteItem",
                                defaultValue: "Create remote item",
                                table: "TermLoop"))
                        .font(.system(size: 12, weight: .medium))
                    Spacer(minLength: 0)
                    Image(systemName: "plus.circle")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                }
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 7)
                .padding(.horizontal, 8)
                .background(Color.accentColor.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isCreateRemoteItemDisabled)
            .opacity(isCreateRemoteItemDisabled ? 0.65 : 1)
        }
    }

    private func rowBackground(_ card: TaskCardSummary) -> Color {
        if selection.selectedTaskId == card.id {
            return Color.accentColor.opacity(0.18)
        }
        if case .failed = card.provisionState {
            return Color.red.opacity(0.07)
        }
        // Resting rows now sit on the sidebar material — drop the per-row
        // `controlBackgroundColor` wash so the list reads like the Work tab
        // (one surface, signal carried by the leading dot + state text).
        return Color.clear
    }

    private func createTask() {
        guard let onCreateTask else { return }
        if let id = onCreateTask(.backlog) {
            selection.select(id)
        }
    }

}

private struct TaskSidebarTipBanner: View {
    let iconSystemName: String
    let title: String
    let subtitle: String
    let action: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: action) {
                HStack(spacing: 8) {
                    Image(systemName: iconSystemName)
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 14)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(TermLoopSidebarTheme.bodyMonoStrong)
                            .lineLimit(1)
                        Text(subtitle)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dimmer)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Color.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(String(localized: "tasks.sidebar.remote.tip.dismiss",
                         defaultValue: "Hide remote sync tip",
                         table: "TermLoop"))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(TermLoopSidebarTheme.activeBg.opacity(0.7))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(TermLoopSidebarTheme.accent.opacity(0.18), lineWidth: 1)
        )
    }
}
