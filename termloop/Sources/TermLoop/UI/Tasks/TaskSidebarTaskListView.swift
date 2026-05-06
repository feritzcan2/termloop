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
    var onOpenSettings: () -> Void = {}

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared

    var body: some View {
        let statuses = agentStatusesByTaskId
        let workItems = workItemsByTaskId
        return VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(store.columnSnapshots) { col in
                        if !col.cards.isEmpty {
                            section(
                                title: store.columnTitle(for: col.id).uppercased(),
                                cards: col.cards,
                                statuses: statuses,
                                workItems: workItems
                            )
                        }
                    }
                    createButton
                }
                .padding(10)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            TaskSidebarSettingsButton(action: onOpenSettings)
                .padding(10)
                .padding(.top, 1)
                .background(Color(nsColor: .windowBackgroundColor))
        }
    }

    private var agentStatusesByTaskId: [UUID: TaskAgentStatusSummary] {
        // Intentional subscription reads: task rows project live agent state
        // without storing agent telemetry in TaskBoardStore.
        _ = metadataStore
        _ = activityStore
        return TaskAgentProjectionBuilder.statusSummaries(for: store.fileSnapshot().tasks)
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
                Text(title)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(.secondary)
                Spacer()
                Text("\(cards.count)")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(.secondary)
            }
            ForEach(cards) { card in
                row(card, status: statuses[card.id], workItem: workItems[card.id])
            }
        }
    }

    private func row(
        _ card: TaskCardSummary,
        status: TaskAgentStatusSummary?,
        workItem: TaskWorkItemSnapshot?
    ) -> some View {
        let statusPresentation = TaskStatusPresentation(
            provisionState: card.provisionState,
            agentStatus: status
        )
        return HStack(alignment: .center, spacing: 7) {
            Circle()
                .fill(statusPresentation.color)
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
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(.blue)
                    .lineLimit(1)
                    .padding(.vertical, 2)
                    .padding(.horizontal, 6)
                    .background(Color.blue.opacity(0.11))
                    .clipShape(Capsule())
            }
            Text(statusPresentation.text)
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(statusPresentation.color)
                .lineLimit(1)
                .padding(.vertical, 2)
                .padding(.horizontal, 6)
                .background(statusPresentation.color.opacity(0.12))
                .clipShape(Capsule())
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 8)
        .background(rowBackground(card))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { selection.select(card.id) }
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

    private func rowBackground(_ card: TaskCardSummary) -> Color {
        if selection.selectedTaskId == card.id {
            return Color.accentColor.opacity(0.18)
        }
        if case .failed = card.provisionState {
            return Color.red.opacity(0.07)
        }
        return Color(nsColor: .controlBackgroundColor).opacity(0.22)
    }

    private func createTask() {
        guard let onCreateTask else { return }
        if let id = onCreateTask(.backlog) {
            selection.select(id)
        }
    }

}
