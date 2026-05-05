// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Top-level Tasks page. Master-detail split: 5-column kanban on top, selected
/// task's detail pane on bottom. Selection lives in the per-window
/// `TaskSelectionStore`; data lives in the per-project `TaskBoardStore`. The
/// `TaskLifecycleCoordinator` is optional for v1 — when not wired, the page
/// still renders read-only.
struct TaskBoardPage: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var coordinator: TaskLifecycleCoordinator?

    var body: some View {
        HorizontalResizableSplit(
            top: { TaskBoardCanvas(store: store, selection: selection, coordinator: coordinator) },
            bottom: {
                TaskDetailPaneView(
                    store: store,
                    selection: selection,
                    onBriefEdit: { id, brief in
                        try? coordinator?.updateBrief(taskId: id, brief: brief)
                    }
                )
            }
        )
    }
}

private struct TaskBoardCanvas: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var coordinator: TaskLifecycleCoordinator?

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 8) {
                ForEach(store.columnSnapshots) { snapshot in
                    TaskBoardColumnView(
                        snapshot: snapshot,
                        selection: selection,
                        onMove: coordinator.map { c in
                            { taskId, target in
                                _Concurrency.Task { @MainActor in
                                    try? await c.moveColumn(taskId: taskId, to: target)
                                }
                            }
                        }
                    )
                    .frame(minWidth: 220)
                }
            }
            .padding(8)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
