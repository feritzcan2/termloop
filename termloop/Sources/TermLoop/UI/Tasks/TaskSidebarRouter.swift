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
        routedBody
            .onAppear { syncSelectionValidity() }
            .onChange(of: selection.selectedTaskId) { _, _ in syncSelectionValidity() }
    }

    @ViewBuilder
    private var routedBody: some View {
        if let detailSnapshot = TaskAgentProjectionBuilder.detailSnapshot(
            in: store,
            selectedTaskId: selection.selectedTaskId
        ) {
            TaskSidebarDrillInView(
                detailSnapshot: detailSnapshot,
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
        } else {
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
        }
    }

    private func syncSelectionValidity() {
        if selection.selectedTaskId != nil,
           TaskAgentProjectionBuilder.detailSnapshot(in: store, selectedTaskId: selection.selectedTaskId) == nil {
            selection.select(nil)
        }
    }
}

/// Per-window root for the sidebar's .tasks tab. Resolves the per-project
/// store and resolves the same window-scoped selection store as the main Tasks
/// route so sidebar drill-in and bottom detail stay in sync.
@MainActor
struct TaskSidebarRoot: View {
    let projectId: UUID?
    let windowId: UUID?
    @StateObject private var fallbackSelection = TaskSelectionStore()

    private var selection: TaskSelectionStore {
        guard let windowId else { return fallbackSelection }
        return TaskSelectionStoreProvider.shared.store(for: windowId)
    }

    var body: some View {
        if let projectId, let store = TaskBoardStoreProvider.shared.store(for: projectId) {
            TaskSidebarRouter(
                store: store,
                selection: selection,
                coordinator: TaskLifecycleCoordinator.makeForProject(store: store)
            )
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
