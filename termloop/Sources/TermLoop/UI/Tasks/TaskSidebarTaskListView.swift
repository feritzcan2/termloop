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
    var onSyncRemoteItems: (() -> Void)?
    var isSyncRemoteItemsDisabled = false
    var isSyncRemoteItemsRunning = false
    var onOpenSettings: () -> Void = {}
    var onRestoreArchived: ((UUID) -> Void)?

    @State private var isArchivedExpanded = false
    @State private var expandedColumnIds: Set<TaskColumnId> = []
    @AppStorage("tasks.sidebar.remoteItemsTipDismissed")
    private var isRemoteItemsTipDismissed = false
    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared
    @ObservedObject private var worktreeProjectionStore = WorktreeProjectionStore.shared
    @EnvironmentObject private var tabManager: TabManager

    var body: some View {
        let statuses = agentStatusesByTaskId
        let workItems = store.settingsSnapshot.remoteSync.isEnabled ? workItemsByTaskId : [:]
        return VStack(spacing: 0) {
            taskListHeader
            Divider().opacity(0.45)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    primaryActions
                    remoteItemsTip
                    if activeTaskCount == 0 {
                        emptyState
                    } else {
                        ForEach(store.columnSnapshots) { col in
                            if !col.cards.isEmpty {
                                section(
                                    columnId: col.id,
                                    title: store.columnTitle(for: col.id),
                                    cards: col.cards,
                                    statuses: statuses,
                                    workItems: workItems
                                )
                            }
                        }
                    }
                    archivedSection(
                        cards: store.archivedSnapshots,
                        workItems: workItems,
                        onRestore: onRestoreArchived
                    )
                }
                .padding(10)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var taskListHeader: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(String(localized: "tasks.sidebar.title",
                            defaultValue: "Tasks",
                            table: "TermLoop"))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.primary)
                Text(taskCountSummary)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button(action: onOpenSettings) {
                Label(String(localized: "tasks.sidebar.settings.short",
                             defaultValue: "Settings",
                             table: "TermLoop"),
                      systemImage: "slider.horizontal.3")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .padding(.vertical, 5)
                    .padding(.horizontal, 8)
                    .background(Color.accentColor.opacity(0.10))
                    .clipShape(Capsule())
                    .overlay(
                        Capsule()
                            .stroke(Color.accentColor.opacity(0.22), lineWidth: 1)
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(String(localized: "tasks.sidebar.settings.open",
                         defaultValue: "Task Settings",
                         table: "TermLoop"))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var remoteItemsTip: some View {
        if !isRemoteItemsTipDismissed {
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

    private var taskCountSummary: String {
        let archivedCount = store.archivedSnapshots.count
        if archivedCount > 0 {
            return String(localized: "tasks.sidebar.countSummary.withArchived",
                          defaultValue: "\(activeTaskCount) active · \(archivedCount) archived",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.countSummary.active",
                      defaultValue: "\(activeTaskCount) active",
                      table: "TermLoop")
    }

    @ViewBuilder
    private func archivedSection(
        cards: [TaskCardSummary],
        workItems: [UUID: TaskWorkItemSnapshot],
        onRestore: ((UUID) -> Void)?
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
                            isArchived: true,
                            onRestore: onRestore
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
        _ = worktreeProjectionStore.version
        return TaskAgentProjectionBuilder.statusSummaries(
            for: store.fileSnapshot().tasks.filter { $0.archivedAt == nil },
            projectId: store.projectId,
            openWorkspaceIds: Set(tabManager.tabs.map(\.id))
        )
    }

    private var workItemsByTaskId: [UUID: TaskWorkItemSnapshot] {
        // Work item bindings are shared workspace metadata; keep Tasks as a
        // read-only projection so sidebar rows update with that store.
        _ = metadataStore
        _ = worktreeProjectionStore.version
        return TaskWorkItemProjectionBuilder.snapshots(
            for: store.fileSnapshot().tasks,
            projectId: store.projectId
        )
    }

    private func section(
        columnId: TaskColumnId,
        title: String,
        cards: [TaskCardSummary],
        statuses: [UUID: TaskAgentStatusSummary],
        workItems: [UUID: TaskWorkItemSnapshot]
    ) -> some View {
        let isExpanded = expandedColumnIds.contains(columnId)
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.12)) {
                    toggleColumnExpansion(columnId)
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 10)
                    Text(TermLoopSidebarTheme.adaptiveSectionTitle(title))
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

            if isExpanded {
                ForEach(cards) { card in
                    row(card, status: statuses[card.id], workItem: workItems[card.id])
                }
            }
        }
        .padding(8)
        .background(taskSidebarSurface.opacity(0.56))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(TermLoopSidebarTheme.rule.opacity(0.9), lineWidth: 1)
        )
    }

    private func toggleColumnExpansion(_ columnId: TaskColumnId) {
        if expandedColumnIds.remove(columnId) == nil {
            expandedColumnIds.insert(columnId)
        }
    }

    private func row(
        _ card: TaskCardSummary,
        status: TaskAgentStatusSummary?,
        workItem: TaskWorkItemSnapshot?,
        isSelectable: Bool = true,
        isArchived: Bool = false,
        onRestore: ((UUID) -> Void)? = nil
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
        return HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
                .padding(.top, 7)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(rowTitle(card, workItem: workItem))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.primary)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if let workItem {
                        Text(workItem.key)
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
                            .lineLimit(1)
                            .padding(.vertical, 1)
                            .padding(.horizontal, 5)
                            .background(Color.accentColor.opacity(0.10))
                            .clipShape(Capsule())
                    }
                }
                Text(rowSubtitle(card))
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            if isArchived, let onRestore {
                Button {
                    onRestore(card.id)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.uturn.backward")
                            .font(.system(size: 9, weight: .semibold))
                        Text(String(localized: "tasks.sidebar.archived.restore",
                                    defaultValue: "restore", table: "TermLoop"))
                            .font(.system(size: 10, weight: .regular))
                    }
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .lineLimit(1)
                }
                .buttonStyle(.plain)
                .help(String(localized: "tasks.sidebar.archived.restore.help",
                             defaultValue: "Restore task",
                             table: "TermLoop"))
            } else {
                rowStatusPill(trailingStatus, color: statusColor)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(rowBackground(card))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(rowBorderColor(card), lineWidth: 1)
        )
        .contentShape(Rectangle())
        .opacity(isArchived ? 0.72 : 1)
        .onTapGesture {
            guard isSelectable else { return }
            selection.select(card.id)
        }
    }

    private func rowStatusPill(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.vertical, 2)
            .padding(.horizontal, 6)
            .background(color.opacity(0.10))
            .clipShape(Capsule())
            .padding(.top, 1)
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

    private var primaryActions: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                createButton
                settingsActionButton
            }
            if store.settingsSnapshot.remoteSync.isEnabled {
                VStack(spacing: 8) {
                    createRemoteItemButton
                    syncRemoteItemsButton
                }
            }
        }
    }

    private var createButton: some View {
        taskActionButton(
            title: String(localized: "tasks.sidebar.newTask",
                          defaultValue: "New task",
                          table: "TermLoop"),
            systemImage: "plus",
            tint: .accentColor,
            isProminent: true,
            isDisabled: onCreateTask == nil,
            isRunning: false,
            action: createTask
        )
    }

    private var settingsActionButton: some View {
        taskActionButton(
            title: String(localized: "tasks.sidebar.settings.open",
                          defaultValue: "Task Settings",
                          table: "TermLoop"),
            systemImage: "slider.horizontal.3",
            tint: .accentColor,
            isProminent: false,
            isDisabled: false,
            isRunning: false,
            action: onOpenSettings
        )
    }

    @ViewBuilder
    private var createRemoteItemButton: some View {
        if let onCreateRemoteItem {
            taskActionButton(
                title: String(localized: "tasks.sidebar.createRemoteItem.short",
                              defaultValue: "Create remote",
                              table: "TermLoop"),
                systemImage: "point.3.connected.trianglepath.dotted",
                tint: .blue,
                isProminent: false,
                isDisabled: isCreateRemoteItemDisabled,
                isRunning: false,
                action: onCreateRemoteItem
            )
        }
    }

    @ViewBuilder
    private var syncRemoteItemsButton: some View {
        if let onSyncRemoteItems {
            taskActionButton(
                title: String(localized: "tasks.sidebar.syncRemoteItems",
                              defaultValue: "Sync remote items",
                              table: "TermLoop"),
                systemImage: "arrow.triangle.2.circlepath",
                tint: .blue,
                isProminent: false,
                isDisabled: isSyncRemoteItemsDisabled,
                isRunning: isSyncRemoteItemsRunning,
                action: onSyncRemoteItems
            )
        }
    }

    private func taskActionButton(
        title: String,
        systemImage: String,
        tint: Color,
        isProminent: Bool,
        isDisabled: Bool,
        isRunning: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isRunning {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 12, height: 12)
                } else {
                    Image(systemName: systemImage)
                        .font(.system(size: 11, weight: .semibold))
                }
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(isProminent ? Color.white : tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .padding(.horizontal, 9)
            .background(isProminent ? tint : tint.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(tint.opacity(isProminent ? 0 : 0.20), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.55 : 1)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 5) {
            Image(systemName: "checklist.unchecked")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text(String(localized: "tasks.sidebar.empty.title",
                        defaultValue: "No tasks yet",
                        table: "TermLoop"))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
            Text(String(localized: "tasks.sidebar.empty.subtitle",
                        defaultValue: "Create a task to start a dedicated worktree and launch agents from here.",
                        table: "TermLoop"))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(taskSidebarSurface.opacity(0.58))
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .stroke(TermLoopSidebarTheme.rule.opacity(0.9), lineWidth: 1)
        )
    }

    private func rowBackground(_ card: TaskCardSummary) -> Color {
        if selection.selectedTaskId == card.id {
            return Color.accentColor.opacity(0.18)
        }
        if case .failed = card.provisionState {
            return Color.red.opacity(0.07)
        }
        return taskSidebarSurface.opacity(0.40)
    }

    private func rowBorderColor(_ card: TaskCardSummary) -> Color {
        if selection.selectedTaskId == card.id {
            return Color.accentColor.opacity(0.28)
        }
        if case .failed = card.provisionState {
            return Color.red.opacity(0.16)
        }
        return TermLoopSidebarTheme.rule.opacity(0.55)
    }

    private var taskSidebarSurface: Color {
        Color(nsColor: .controlBackgroundColor)
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
