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
    @State private var isShowingCreateRemoteItem = false
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
            .sheet(isPresented: $isShowingCreateRemoteItem) {
                createRemoteItemSheet
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
                onUpdateTitle: coordinator.map { c in
                    { id, title in try? c.updateTitle(taskId: id, title: title) }
                },
                onUpdateBrief: coordinator.map { c in
                    { id, brief in try? c.updateBrief(taskId: id, brief: brief) }
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
                onCreateRemoteItem: { beginCreateRemoteItem() },
                isCreateRemoteItemDisabled: remoteSync.isSyncing,
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

    private func beginCreateRemoteItem() {
        guard remoteSync.settings.isEnabled else {
            isShowingSettings = true
            return
        }
        guard remoteSync.settings.container?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty == false else {
            isShowingSettings = true
            return
        }
        isShowingCreateRemoteItem = true
    }

    @ViewBuilder
    private var createRemoteItemSheet: some View {
        TaskCreateRemoteItemSheet(
            provider: remoteSync.settings.provider,
            container: remoteSync.settings.container ?? "",
            onCancel: { isShowingCreateRemoteItem = false },
            onCreate: { title, bodyMarkdown in
                isShowingCreateRemoteItem = false
                remoteSync.createRemoteWorkItem(
                    title: title,
                    bodyMarkdown: bodyMarkdown,
                    onCreated: { taskId in selection.select(taskId) }
                )
            }
        )
        .frame(width: 520)
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

private struct TaskCreateRemoteItemSheet: View {
    let provider: RemoteWorkItemProviderId
    let container: String
    let onCancel: () -> Void
    let onCreate: (String, String?) -> Void

    @State private var title = ""
    @State private var bodyMarkdown = ""

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedBody: String? {
        let value = bodyMarkdown.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(String(localized: "tasks.remoteCreate.title",
                            defaultValue: "Create \(provider.displayLabel) Item",
                            table: "TermLoop"))
                    .font(.system(size: 18, weight: .semibold))
                Text(container)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(String(localized: "tasks.remoteCreate.field.title",
                            defaultValue: "Title",
                            table: "TermLoop"))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                TextField(String(localized: "tasks.remoteCreate.field.title.placeholder",
                                 defaultValue: "What needs to be done?",
                                 table: "TermLoop"),
                          text: $title)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(String(localized: "tasks.remoteCreate.field.description",
                            defaultValue: "Description",
                            table: "TermLoop"))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                TextEditor(text: $bodyMarkdown)
                    .font(.system(size: 13))
                    .frame(minHeight: 150)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color.secondary.opacity(0.18), lineWidth: 1)
                    )
            }

            HStack {
                Spacer()
                Button(String(localized: "common.cancel",
                              defaultValue: "Cancel",
                              table: "TermLoop"),
                       action: onCancel)
                Button(String(localized: "tasks.remoteCreate.create",
                              defaultValue: "Create",
                              table: "TermLoop")) {
                    onCreate(trimmedTitle, trimmedBody)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(trimmedTitle.isEmpty)
            }
        }
        .padding(18)
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
            title: task.title,
            status: task.remoteStatusLabel,
            url: reference.url
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
