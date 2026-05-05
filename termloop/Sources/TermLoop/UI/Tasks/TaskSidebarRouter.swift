// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar entry point on the .tasks tab. Switches between the task list and
/// the per-task drill-in based on selection. Mirrors the per-window split:
/// `selection` is per-window state, `store` is per-project state.
struct TaskSidebarRouter: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var coordinator: TaskLifecycleCoordinator?

    var body: some View {
        if selection.selectedTaskId == nil {
            TaskSidebarTaskListView(
                store: store,
                selection: selection,
                onCreateTask: coordinator.map { c in
                    { columnId in
                        let title = String(localized: "tasks.sidebar.newTaskDefaultTitle",
                                           defaultValue: "Untitled task", table: "TermLoop")
                        return try? c.createTask(title: title, columnId: columnId)
                    }
                }
            )
        } else {
            TaskSidebarDrillInView(
                store: store,
                selection: selection,
                onRebind: coordinator.map { c in
                    { id in
                        _Concurrency.Task { @MainActor in
                            try? await c.bindWorktree(taskId: id)
                        }
                    }
                },
                onUnbind: coordinator.map { c in
                    { id in try? c.unbindWorktree(taskId: id) }
                },
                onArchive: coordinator.map { c in
                    { id in try? c.archiveTask(id) }
                }
            )
        }
    }
}

/// Per-window root for the sidebar's .tasks tab. Resolves the per-project
/// store and instantiates a per-window selection store as a @StateObject so
/// the existing sidebar body can dispatch into it cleanly.
@MainActor
struct TaskSidebarRoot: View {
    let projectId: UUID?
    @StateObject private var selection = TaskSelectionStore()

    var body: some View {
        if let projectId, let store = TaskBoardStoreProvider.shared.store(for: projectId) {
            TaskSidebarRouter(store: store, selection: selection)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text(String(localized: "tasks.sidebar.noProject",
                            defaultValue: "Open a project to see its tasks.",
                            table: "TermLoop"))
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                Spacer()
            }
            .padding(8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}
