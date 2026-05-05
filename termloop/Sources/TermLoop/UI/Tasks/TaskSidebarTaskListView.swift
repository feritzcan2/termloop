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
            LazyVStack(alignment: .leading, spacing: 4) {
                ForEach(store.columnSnapshots) { col in
                    if !col.cards.isEmpty {
                        section(title: title(for: col.id), cards: col.cards)
                    }
                }
                createButton
            }
            .padding(8)
        }
    }

    private func section(title: String, cards: [TaskCardSummary]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
                .padding(.top, 4)
            ForEach(cards) { card in
                row(card)
            }
        }
    }

    private func row(_ card: TaskCardSummary) -> some View {
        HStack(spacing: 6) {
            Circle().fill(dotColor(card.provisionState)).frame(width: 6, height: 6)
            Text(card.title).font(.system(size: 12)).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
        .background(selection.selectedTaskId == card.id
            ? Color.accentColor.opacity(0.18)
            : Color.clear)
        .cornerRadius(3)
        .contentShape(Rectangle())
        .onTapGesture { selection.select(card.id) }
    }

    private var createButton: some View {
        Button(action: createTask) {
            Text(String(localized: "tasks.sidebar.newTask",
                        defaultValue: "+ New task", table: "TermLoop"))
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
                .padding(.horizontal, 6)
        }
        .buttonStyle(.plain)
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

    private func dotColor(_ s: TaskProvisionState) -> Color {
        switch s {
        case .pending: return .orange
        case .failed: return .red
        case .ready: return .green
        case .none: return .gray
        }
    }
}
