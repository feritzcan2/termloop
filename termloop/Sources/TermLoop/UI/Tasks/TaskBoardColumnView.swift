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
    var onMove: ((_ taskId: UUID, _ to: TaskColumnId) -> Void)?
    var onCommandClick: ((TaskCardSummary) -> Void)?
    var onArchive: ((UUID) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(displayTitle)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.secondary)
                Spacer()
                Text("\(snapshot.cards.count)")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 6)

            ScrollView(.vertical) {
                LazyVStack(spacing: 4) {
                    ForEach(snapshot.cards) { card in
                        TaskCardView(
                            card: card,
                            selection: selection,
                            onCommandClick: onCommandClick,
                            onArchive: onArchive
                        )
                    }
                }
                .padding(.horizontal, 4)
                .padding(.bottom, 8)
            }
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(Color(nsColor: .underPageBackgroundColor).opacity(0.5))
        .cornerRadius(6)
        .onDrop(of: [.text], isTargeted: nil, perform: handleDrop(providers:))
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
