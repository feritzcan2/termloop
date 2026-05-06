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

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(store.columnSnapshots) { col in
                    if !col.cards.isEmpty {
                        section(title: title(for: col.id), cards: col.cards)
                    }
                }
                createButton
            }
            .padding(10)
        }
    }

    private func section(title: String, cards: [TaskCardSummary]) -> some View {
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
                row(card)
            }
        }
    }

    private func row(_ card: TaskCardSummary) -> some View {
        HStack(alignment: .center, spacing: 7) {
            Circle()
                .fill(card.provisionState.taskStatusColor)
                .frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
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
            Text(card.provisionState.taskCompactStatusText)
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(card.provisionState.taskStatusColor)
                .lineLimit(1)
                .padding(.vertical, 2)
                .padding(.horizontal, 6)
                .background(card.provisionState.taskStatusColor.opacity(0.12))
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

    private func title(for id: TaskColumnId) -> String {
        switch id {
        case .backlog: return String(localized: "tasks.column.backlog", defaultValue: "BACKLOG", table: "TermLoop")
        case .todo: return String(localized: "tasks.column.todo", defaultValue: "TODO", table: "TermLoop")
        case .inProgress: return String(localized: "tasks.column.in_progress", defaultValue: "IN PROGRESS", table: "TermLoop")
        case .inReview: return String(localized: "tasks.column.in_review", defaultValue: "IN REVIEW", table: "TermLoop")
        case .done: return String(localized: "tasks.column.done", defaultValue: "DONE", table: "TermLoop")
        }
    }

}
