// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI
import UniformTypeIdentifiers

/// One kanban column. Renders header (title + count) and a vertical stack of
/// `TaskCardView`s. Drop target accepts the dragged task id; the actual move
/// dispatches through `TaskLifecycleCoordinator` when an `onMove` closure is
/// provided. Column views without an `onMove` closure render but do not move.
struct TaskBoardColumnView: View {
    let snapshot: TaskColumnSnapshot
    @ObservedObject var selection: TaskSelectionStore
    let agentStatusesByTaskId: [UUID: TaskAgentStatusSummary]
    var onMove: ((_ taskId: UUID, _ to: TaskColumnId) -> Void)?
    var onSelect: ((TaskCardSummary) -> Void)?
    var onCommandClick: ((TaskCardSummary) -> Void)?
    var onArchive: ((UUID) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            header
            ScrollView(.vertical) {
                LazyVStack(spacing: 8) {
                    if snapshot.cards.isEmpty {
                        emptyDropHint
                    } else {
                        ForEach(snapshot.cards) { card in
                            TaskCardView(
                                card: card,
                                agentStatus: agentStatusesByTaskId[card.id],
                                selection: selection,
                                onSelect: onSelect,
                                onCommandClick: onCommandClick,
                                onArchive: onArchive
                            )
                        }
                    }
                }
                .padding(.horizontal, 7)
                .padding(.bottom, 12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .padding(.top, 10)
        .background(columnBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.white.opacity(0.05), lineWidth: 1)
        )
        .onDrop(of: [.text], isTargeted: nil, perform: handleDrop(providers:))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(displayTitle)
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(.secondary)
                .kerning(0.45)
            Spacer(minLength: 0)
            Text("\(snapshot.cards.count)")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundColor(.secondary)
                .padding(.vertical, 2)
                .padding(.horizontal, 6)
                .background(Color.white.opacity(0.05))
                .clipShape(Capsule())
        }
        .padding(.horizontal, 10)
    }

    private var emptyDropHint: some View {
        VStack(spacing: 6) {
            Image(systemName: "arrow.down.to.line.compact")
                .font(.system(size: 14, weight: .medium))
            Text(String(localized: "tasks.column.emptyDropHint",
                        defaultValue: "Drop tasks here", table: "TermLoop"))
                .font(.system(size: 11, weight: .medium))
        }
        .foregroundColor(.secondary.opacity(0.55))
        .frame(maxWidth: .infinity, minHeight: 96)
        .background(Color.black.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundColor(.secondary.opacity(0.16))
        )
    }

    private var columnBackground: Color {
        Color(nsColor: .underPageBackgroundColor).opacity(0.70)
    }

    private var displayTitle: String {
        switch snapshot.id {
        case .backlog:
            return String(localized: "tasks.column.backlog",
                          defaultValue: "BACKLOG", table: "TermLoop")
        case .todo:
            return String(localized: "tasks.column.todo",
                          defaultValue: "TODO", table: "TermLoop")
        case .inProgress:
            return String(localized: "tasks.column.in_progress",
                          defaultValue: "IN PROGRESS", table: "TermLoop")
        case .inReview:
            return String(localized: "tasks.column.in_review",
                          defaultValue: "IN REVIEW", table: "TermLoop")
        case .done:
            return String(localized: "tasks.column.done",
                          defaultValue: "DONE", table: "TermLoop")
        }
    }

    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        guard let onMove, let provider = providers.first else { return false }
        let targetColumn = snapshot.id
        provider.loadObject(ofClass: NSString.self) { object, error in
            #if DEBUG
            if let error {
                print("TaskBoardColumnView drop loadObject error: \(error)")
            }
            #endif
            guard let text = object as? String, let id = UUID(uuidString: text) else {
                #if DEBUG
                print("TaskBoardColumnView drop: invalid payload (object=\(String(describing: object)))")
                #endif
                return
            }
            DispatchQueue.main.async {
                #if DEBUG
                print("TaskBoardColumnView drop dispatch: id=\(id) → \(targetColumn)")
                #endif
                onMove(id, targetColumn)
            }
        }
        return true
    }
}
