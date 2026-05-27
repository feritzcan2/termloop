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
    @State private var isCreatingRemoteItem = false
    @State private var createRemoteItemError: String?
    @State private var createWorktreeTaskId: UUID?
    @State private var linkWorktreeTaskId: UUID?

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
            .sheet(isPresented: linkWorktreeSheetBinding) {
                linkWorktreeSheet
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
                projectId: store.projectId,
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
                onRefineTaskSpec: coordinator.map { c in
                    { id in
                        refineTaskSpec(taskId: id, coordinator: c)
                    }
                },
                onExecuteTaskSpec: coordinator.map { c in
                    { id in
                        executeTaskSpec(taskId: id, coordinator: c)
                    }
                },
                onUpdateTitle: coordinator.map { c in
                    { id, title in try? c.updateTitle(taskId: id, title: title) }
                },
                onUpdateBrief: coordinator.map { c in
                    { id, brief in try? c.updateBrief(taskId: id, brief: brief) }
                },
                onCreateWorktree: coordinator == nil ? nil : { id in createWorktreeTaskId = id },
                onLinkWorktree: coordinator == nil ? nil : { id in linkWorktreeTaskId = id },
                onStartAgent: coordinator == nil ? nil : { id in startAgent(taskId: id) },
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
                onSyncRemoteItems: {
                    remoteSync.syncAssignedToMe(reason: "tasks.sidebar.syncRemoteItems")
                },
                isSyncRemoteItemsDisabled: remoteSync.isSyncing || !remoteSync.settings.isAssignedSyncEnabled,
                isSyncRemoteItemsRunning: remoteSync.isSyncing,
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


    private func refineTaskSpec(taskId: UUID, coordinator: TaskLifecycleCoordinator) {
        guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
            return
        }
        do {
            let path = try coordinator.ensureTaskSpecFile(taskId: taskId)
            TaskQuickActions.refineTaskSpecWithAgent(
                taskTitle: task.title,
                taskFilePath: path,
                workspaceId: task.workspaceId,
                projectId: store.projectId
            )
        } catch {
            #if DEBUG
            print("TaskSidebarRouter.refineTaskSpec failed: \(error)")
            #endif
        }
    }

    private func executeTaskSpec(taskId: UUID, coordinator: TaskLifecycleCoordinator) {
        guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
            return
        }
        do {
            let path = try coordinator.ensureTaskSpecFile(taskId: taskId)
            let launchContext = try? agentLaunchContext(taskId: taskId)
            TaskQuickActions.executeTaskSpecWithAgent(
                taskTitle: task.title,
                workspaceId: launchContext?.targetWorkspaceId ?? task.workspaceId,
                projectId: store.projectId,
                promptText: executionPromptText(for: task, taskFilePath: path),
                launchContext: launchContext
            )
        } catch {
            #if DEBUG
            print("TaskSidebarRouter.executeTaskSpec failed: \(error)")
            #endif
        }
    }

    private func startAgent(taskId: UUID) {
        do {
            let context = try agentLaunchContext(taskId: taskId)
            TaskQuickActions.startAgentFromTasks(
                context: context,
                onLaunchedWorkspaceId: { workspaceId in
                    selection.openInlineTerminal(workspaceId: workspaceId)
                    TaskQuickActions.showWorkspaceInline(workspaceId: workspaceId)
                }
            )
        } catch {
            #if DEBUG
            print("TaskSidebarRouter.startAgent failed: \(error)")
            #endif
        }
    }

    private func executionPromptText(for task: TaskRecord, taskFilePath: String) -> String {
        let taskMarkdown = (try? String(contentsOfFile: taskFilePath, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let taskMarkdown, !taskMarkdown.isEmpty {
            return taskMarkdown
        }
        let body = task.remoteWorkItem
            .flatMap { RemoteWorkItemSnapshotStore.shared.snapshot(for: $0) }?
            .bodyMarkdown?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let body, !body.isEmpty {
            return body
        }
        if let brief = task.brief?.trimmingCharacters(in: .whitespacesAndNewlines),
           !brief.isEmpty {
            return brief
        }
        return task.title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func agentLaunchContext(taskId: UUID) throws -> TaskAgentLaunchContext {
        guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
            throw TaskLifecycleError.taskNotFound(taskId)
        }
        let targetWorkspace = task.workspaceId.flatMap { AppDelegate.shared?.workspaceFor(tabId: $0) }
        let normalizedWorktreePath = TaskPathNormalization
            .resolveDisplayAndKey(task.worktreePath, relativeTo: store.projectRoot)?
            .displayPath
        let cwdPath = nonEmptyTrimmed(normalizedWorktreePath)
            ?? nonEmptyTrimmed(targetWorkspace?.termLoopPresentationCwd())
        guard let cwdPath else {
            throw TaskLifecycleError.notBound(taskId)
        }
        let branch = nonEmptyTrimmed(task.branch)
            ?? targetWorkspace.flatMap { nonEmptyTrimmed(WorkspaceMetadataStore.shared.branch(for: $0)) }
            ?? (try? GitWorktreeService().currentBranch(in: cwdPath)).flatMap(nonEmptyTrimmed)
            ?? TaskPathNormalization.resolveDisplayAndKey(cwdPath)?.leafName
            ?? nonEmptyTrimmed(task.title)
        return TaskAgentLaunchContext(
            targetWorkspaceId: targetWorkspace?.id,
            projectId: store.projectId,
            cwdPath: cwdPath,
            branchName: branch
        )
    }

    private func nonEmptyTrimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
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
        createRemoteItemError = nil
        isCreatingRemoteItem = false
        isShowingCreateRemoteItem = true
        remoteSync.loadIssueTypeOptionsIfNeeded()
    }

    @ViewBuilder
    private var createRemoteItemSheet: some View {
        TaskCreateRemoteItemSheet(
            provider: remoteSync.settings.provider,
            container: remoteSync.settings.container ?? "",
            issueTypes: remoteSync.issueTypeOptions,
            isLoadingIssueTypes: remoteSync.isLoadingIssueTypes,
            issueTypeMessage: remoteSync.issueTypeOptionsMessage,
            isCreating: isCreatingRemoteItem,
            errorMessage: createRemoteItemError,
            onCancel: {
                guard !isCreatingRemoteItem else { return }
                isShowingCreateRemoteItem = false
            },
            onCreate: { title, bodyMarkdown, issueType in
                createRemoteItemError = nil
                isCreatingRemoteItem = true
                remoteSync.createRemoteWorkItem(
                    title: title,
                    bodyMarkdown: bodyMarkdown,
                    issueType: issueType,
                    onCreated: { taskId in
                        selection.select(taskId)
                        isCreatingRemoteItem = false
                        isShowingCreateRemoteItem = false
                    },
                    onFailed: { message in
                        createRemoteItemError = message
                        isCreatingRemoteItem = false
                    }
                )
            }
        )
        .frame(width: 520)
        .interactiveDismissDisabled(isCreatingRemoteItem)
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

    private var linkWorktreeSheetBinding: Binding<Bool> {
        Binding(
            get: { coordinator != nil && linkWorktreeTask != nil },
            set: { isPresented in
                if !isPresented {
                    linkWorktreeTaskId = nil
                }
            }
        )
    }

    private var linkWorktreeTask: TaskRecord? {
        guard let taskId = linkWorktreeTaskId else { return nil }
        return store.fileSnapshot().tasks.first { $0.id == taskId }
    }

    @ViewBuilder
    private var linkWorktreeSheet: some View {
        if let coordinator,
           let task = linkWorktreeTask {
            let store = store
            TaskLinkWorktreeSheet(
                task: task,
                projectId: store.projectId,
                loadExistingPaths: {
                    TaskSidebarRouter.linkedWorktreeKeys(
                        in: store.fileSnapshot().tasks,
                        excluding: task.id,
                        projectRoot: store.projectRoot
                    )
                },
                onLink: { descriptor in
                    guard let workspaceId = descriptor.workspaceId else { return }
                    try coordinator.bindExistingWorktree(
                        taskId: task.id,
                        workspaceId: workspaceId,
                        branch: descriptor.branch ?? "",
                        worktreePath: descriptor.worktreePath,
                        ownsWorktree: false
                    )
                    linkWorktreeTaskId = nil
                },
                onCancel: { linkWorktreeTaskId = nil }
            )
        } else {
            EmptyView()
        }
    }

    private static func linkedWorktreeKeys(
        in tasks: [TaskRecord],
        excluding taskId: UUID,
        projectRoot: URL
    ) -> Set<String> {
        var seen: Set<String> = []
        for task in tasks {
            guard task.id != taskId, task.archivedAt == nil else { continue }
            guard let path = task.worktreePath,
                  let key = TaskPathNormalization.resolveDisplayAndKey(path, relativeTo: projectRoot)?.keyPath
            else { continue }
            seen.insert(key)
        }
        return seen
    }
}

private struct TaskCreateRemoteItemSheet: View {
    private static let customIssueTypeTag = "__termloop_custom_issue_type__"

    let provider: RemoteWorkItemProviderId
    let container: String
    let issueTypes: [TaskRemoteIssueTypeOption]
    let isLoadingIssueTypes: Bool
    let issueTypeMessage: String?
    let isCreating: Bool
    let errorMessage: String?
    let onCancel: () -> Void
    let onCreate: (String, String?, String?) -> Void

    @State private var title = ""
    @State private var bodyMarkdown = ""
    @State private var selectedIssueType = ""
    @State private var customIssueType = ""

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedBody: String? {
        let value = bodyMarkdown.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private var selectableIssueTypes: [TaskRemoteIssueTypeOption] {
        let nonSubtaskTypes = issueTypes.filter { !$0.isSubtask }
        return nonSubtaskTypes.isEmpty ? issueTypes : nonSubtaskTypes
    }

    private var isCustomIssueTypeSelected: Bool {
        selectedIssueType == Self.customIssueTypeTag || selectableIssueTypes.isEmpty
    }

    private var trimmedCustomIssueType: String? {
        let value = customIssueType.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private var selectedIssueTypeForCreate: String? {
        guard provider == .jira else { return nil }
        if isCustomIssueTypeSelected {
            return trimmedCustomIssueType
        }
        let value = selectedIssueType.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private var canCreate: Bool {
        guard !trimmedTitle.isEmpty, !isCreating else { return false }
        guard provider == .jira else { return true }
        return selectedIssueTypeForCreate != nil
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
                    .disabled(isCreating)
            }

            if provider == .jira {
                jiraIssueTypeSection
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
                    .disabled(isCreating)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color.secondary.opacity(0.18), lineWidth: 1)
                    )
            }

            if isCreating {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(String(localized: "tasks.remoteCreate.creating",
                                defaultValue: "Creating remote item and linking local task…",
                                table: "TermLoop"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }

            if let errorMessage, !errorMessage.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(String(localized: "tasks.remoteCreate.error",
                                defaultValue: "Create failed",
                                table: "TermLoop"))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.red)
                    ScrollView {
                        Text(errorMessage)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                    .frame(maxHeight: 120)
                    .background(Color.red.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color.red.opacity(0.20), lineWidth: 1)
                    )
                }
            }

            HStack {
                Spacer()
                Button(String(localized: "common.cancel",
                              defaultValue: "Cancel",
                              table: "TermLoop"),
                       action: onCancel)
                    .disabled(isCreating)
                Button(String(localized: "tasks.remoteCreate.create",
                              defaultValue: "Create",
                              table: "TermLoop")) {
                    onCreate(trimmedTitle, trimmedBody, selectedIssueTypeForCreate)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canCreate)
            }
        }
        .padding(18)
        .onAppear(perform: ensureIssueTypeSelection)
        .onChange(of: issueTypes) { _, _ in ensureIssueTypeSelection() }
    }

    @ViewBuilder
    private var jiraIssueTypeSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(String(localized: "tasks.remoteCreate.field.type",
                        defaultValue: "Type",
                        table: "TermLoop"))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)

            if !selectableIssueTypes.isEmpty {
                Picker(
                    String(localized: "tasks.remoteCreate.field.type",
                           defaultValue: "Type",
                           table: "TermLoop"),
                    selection: $selectedIssueType
                ) {
                    ForEach(selectableIssueTypes) { issueType in
                        Text(issueType.name).tag(issueType.name)
                    }
                    Text(String(localized: "tasks.remoteCreate.field.type.custom",
                                defaultValue: "Custom…",
                                table: "TermLoop"))
                        .tag(Self.customIssueTypeTag)
                }
                .labelsHidden()
                .disabled(isCreating)
            } else if isLoadingIssueTypes {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(String(localized: "tasks.remoteCreate.issueType.loading",
                                defaultValue: "Loading Jira issue types…",
                                table: "TermLoop"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }

            if isCustomIssueTypeSelected {
                TextField(String(localized: "tasks.remoteCreate.field.type.placeholder",
                                 defaultValue: "Task, Story, Bug…",
                                 table: "TermLoop"),
                          text: $customIssueType)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isCreating)
            }

            if let message = issueTypeMessage?.trimmingCharacters(in: .whitespacesAndNewlines),
               !message.isEmpty {
                Text(message)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(selectableIssueTypes.isEmpty ? .red : .secondary)
                    .textSelection(.enabled)
                    .lineLimit(4)
            }
        }
    }

    private func ensureIssueTypeSelection() {
        guard provider == .jira else { return }
        guard !selectableIssueTypes.isEmpty else {
            selectedIssueType = Self.customIssueTypeTag
            return
        }
        if selectedIssueType == Self.customIssueTypeTag, trimmedCustomIssueType != nil { return }
        if selectableIssueTypes.contains(where: { $0.name == selectedIssueType }) { return }
        selectedIssueType = defaultIssueTypeName(in: selectableIssueTypes)
    }

    private func defaultIssueTypeName(in issueTypes: [TaskRemoteIssueTypeOption]) -> String {
        let preferredNames = ["Task", "Story", "Bug", "Feature Request"]
        for preferredName in preferredNames {
            if let match = issueTypes.first(where: { $0.name.caseInsensitiveCompare(preferredName) == .orderedSame }) {
                return match.name
            }
        }
        return issueTypes[0].name
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

private struct TaskLinkWorktreeSheet: View {
    let task: TaskRecord
    let projectId: UUID
    let loadExistingPaths: () -> Set<String>
    let onLink: (TaskWorkspaceDescriptor) throws -> Void
    let onCancel: () -> Void

    @State private var candidates: [Candidate]?
    @State private var errorMessage: String?
    @State private var selectedKey: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(String(localized: "tasks.linkWorktree.title",
                            defaultValue: "Link Existing Worktree",
                            table: "TermLoop"))
                    .font(.system(size: 18, weight: .semibold))
                Text(task.title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            content

            if let errorMessage, !errorMessage.isEmpty {
                Text(errorMessage)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .lineLimit(4)
            }

            HStack {
                Spacer()
                Button(String(localized: "common.cancel",
                              defaultValue: "Cancel",
                              table: "TermLoop"),
                       action: onCancel)
                Button(String(localized: "tasks.linkWorktree.link",
                              defaultValue: "Link",
                              table: "TermLoop")) {
                    performLink()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(selectedKey == nil)
            }
        }
        .padding(18)
        .frame(width: 520)
        .task { await loadCandidates() }
    }

    @ViewBuilder
    private var content: some View {
        switch candidates {
        case nil:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(String(localized: "tasks.linkWorktree.loading",
                            defaultValue: "Loading worktrees…",
                            table: "TermLoop"))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 160, alignment: .center)
        case let .some(items) where items.isEmpty:
            VStack(spacing: 6) {
                Image(systemName: "tray")
                    .font(.system(size: 22, weight: .light))
                    .foregroundStyle(.secondary)
                Text(String(localized: "tasks.linkWorktree.empty",
                            defaultValue: "No unlinked worktrees with a workspace are available in this project.",
                            table: "TermLoop"))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
            }
            .frame(maxWidth: .infinity, minHeight: 160, alignment: .center)
        case let .some(items):
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(items) { candidate in
                        row(candidate)
                    }
                }
            }
            .frame(minHeight: 200, maxHeight: 320)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color.secondary.opacity(0.18), lineWidth: 1)
            )
        }
    }

    @ViewBuilder
    private func row(_ candidate: Candidate) -> some View {
        let isSelected = selectedKey == candidate.keyPath
        Button {
            selectedKey = candidate.keyPath
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 16, height: 16)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(candidate.displayLabel)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(candidate.displayPath)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func performLink() {
        guard let key = selectedKey,
              let candidate = candidates?.first(where: { $0.keyPath == key }) else { return }
        do {
            try onLink(candidate.descriptor)
        } catch {
            errorMessage = (error as NSError).localizedDescription
        }
    }

    private func loadCandidates() async {
        let projectRoot = TaskBoardWorkspaceListingAdapter.shared.projectRoot(for: projectId)
        let existingPaths = loadExistingPaths()
        let snapshot = await TaskBoardWorkspaceListingAdapter.shared.workspaceSnapshot(in: projectId)
        candidates = snapshot.descriptors
            .compactMap { descriptor -> Candidate? in
                guard descriptor.workspaceId != nil else { return nil }
                guard let resolved = TaskPathNormalization.resolveDisplayAndKey(
                    descriptor.worktreePath, relativeTo: projectRoot)
                else { return nil }
                guard !existingPaths.contains(resolved.keyPath) else { return nil }
                return Candidate(
                    keyPath: resolved.keyPath,
                    displayPath: resolved.displayPath,
                    leafName: resolved.leafName,
                    descriptor: descriptor
                )
            }
            .sorted { $0.leafName.localizedCaseInsensitiveCompare($1.leafName) == .orderedAscending }
    }

    struct Candidate: Identifiable {
        let keyPath: String
        let displayPath: String
        let leafName: String
        let descriptor: TaskWorkspaceDescriptor

        var id: String { keyPath }

        var displayLabel: String {
            let trimmed = descriptor.branch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? leafName : trimmed
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
