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
    @ObservedObject private var remoteSync: TaskRemoteSyncCoordinator
    @State private var isShowingSettings = false
    @State private var createWorktreeTaskId: UUID?

    init(
        store: TaskBoardStore,
        selection: TaskSelectionStore,
        coordinator: TaskLifecycleCoordinator?
    ) {
        self.store = store
        self.selection = selection
        self.coordinator = coordinator
        self.remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
    }

    var body: some View {
        routedBody
            .onAppear { syncSelectionValidity() }
            .onChange(of: selection.selectedTaskId) { _, _ in syncSelectionValidity() }
            .sheet(isPresented: createWorktreeSheetBinding) {
                createWorktreeSheet
            }
    }

    @ViewBuilder
    private var routedBody: some View {
        if isShowingSettings {
            TaskSettingsSidebarView(
                remoteSync: remoteSync,
                onBack: { isShowingSettings = false }
            )
        } else if let detailSnapshot = TaskAgentProjectionBuilder.detailSnapshot(
            in: store,
            selectedTaskId: selection.selectedTaskId
        ) {
            TaskSidebarDrillInView(
                detailSnapshot: detailSnapshot,
                selection: selection,
                remoteSync: remoteSync,
                columnTitle: { store.columnTitle(for: $0) },
                onRebind: coordinator.map { c in
                    { id in
                        _Concurrency.Task { @MainActor in
                            try? await c.bindWorktree(taskId: id)
                        }
                    }
                },
                onOpenTaskSpec: coordinator.map { c in
                    { id in
                        openTaskSpec(taskId: id, coordinator: c, title: detailSnapshot.title)
                    }
                },
                onCreateWorktree: coordinator == nil ? nil : { id in createWorktreeTaskId = id },
                onOpenSettings: { isShowingSettings = true },
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
                },
                onOpenSettings: { isShowingSettings = true }
            )
        }
    }

    private func syncSelectionValidity() {
        if selection.selectedTaskId != nil,
           TaskAgentProjectionBuilder.detailSnapshot(in: store, selectedTaskId: selection.selectedTaskId) == nil {
            selection.select(nil)
        }
    }

    private func openTaskSpec(taskId: UUID, coordinator: TaskLifecycleCoordinator, title: String) {
        do {
            let path = try coordinator.ensureTaskSpecFile(taskId: taskId)
            TaskQuickActions.openTaskFile(path: path, displayTitle: title)
        } catch {
            #if DEBUG
            print("TaskSidebarRouter.openTaskSpec failed: \(error)")
            #endif
        }
    }

    private var createWorktreeSheetBinding: Binding<Bool> {
        Binding(
            get: { coordinator != nil && createWorktreeTask != nil },
            set: { isPresented in
                if !isPresented {
                    createWorktreeTaskId = nil
                }
            }
        )
    }

    private var createWorktreeTask: TaskRecord? {
        guard let taskId = createWorktreeTaskId else { return nil }
        return store.fileSnapshot().tasks.first { $0.id == taskId }
    }

    @ViewBuilder
    private var createWorktreeSheet: some View {
        if let coordinator,
           let task = createWorktreeTask {
            TaskCreateWorktreeSheet(
                task: task,
                onWorkspaceCreated: { creation in
                    try coordinator.bindExistingWorktree(
                        taskId: task.id,
                        workspaceId: creation.workspace.id,
                        branch: creation.branch,
                        worktreePath: creation.worktreePath,
                        ownsWorktree: creation.createdWorktree
                    )
                },
                onCancel: { createWorktreeTaskId = nil },
                onSuccess: { createWorktreeTaskId = nil }
            )
        } else {
            EmptyView()
        }
    }
}

private struct TaskCreateWorktreeSheet: View {
    let task: TaskRecord
    let onWorkspaceCreated: (NewWorkspaceWithWorktreeForm.Creation) throws -> Void
    let onCancel: () -> Void
    let onSuccess: () -> Void

    var body: some View {
        NewWorkspaceWithWorktreeForm(
            request: request,
            tabManager: AppDelegate.shared?.tabManager,
            showsPromptEditors: false,
            showsAgentPickerControl: false,
            activatesWorkspaceOnSuccess: false,
            onWorkspaceCreated: onWorkspaceCreated,
            onCancel: onCancel,
            onSuccess: onSuccess
        )
        .frame(width: 560)
    }

    private var request: NewWorkspaceWithWorktreeRequest {
        NewWorkspaceWithWorktreeRequest(
            projectId: task.projectId,
            terminalAgentId: nil,
            suggestedBranchName: suggestedBranchName,
            assignedTicket: assignedTicket
        )
    }

    private var assignedTicket: WorkspaceMetadataStore.AssignedTicket? {
        guard let reference = task.remoteWorkItem else { return nil }
        return WorkspaceMetadataStore.AssignedTicket(
            providerName: reference.provider.displayLabel,
            key: reference.key,
            title: task.title
        )
    }

    private var suggestedBranchName: String? {
        let stored = nonEmptyTrimmed(task.branch)
        if let stored { return stored }
        let key = nonEmptyTrimmed(task.remoteWorkItem?.key)
        return key.map { "feature/\($0)" }
    }

    private func nonEmptyTrimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
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
            .id(projectId)
            .onAppear {
                TaskBoardReconcileHook.bootstrap()
                TaskBoardReconcileScheduler.shared.request(projectId: projectId, reason: "taskSidebar.appear")
            }
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
