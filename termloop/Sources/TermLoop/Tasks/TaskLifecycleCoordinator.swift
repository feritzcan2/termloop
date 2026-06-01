// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public struct TaskWorktreeProvisionResult: Equatable, Sendable {
    public let workspaceId: UUID
    public let branch: String
    public let worktreePath: String
    public let createdWorktree: Bool

    public init(
        workspaceId: UUID,
        branch: String,
        worktreePath: String,
        createdWorktree: Bool = false
    ) {
        self.workspaceId = workspaceId
        self.branch = branch
        self.worktreePath = worktreePath
        self.createdWorktree = createdWorktree
    }
}

@MainActor
public protocol TaskBoundWorkspaceMetadataStoring: AnyObject {
    func setBinding(workspaceId: UUID, branch: String, path: String) throws
    func clearBinding(workspaceId: UUID) throws
    func workspaceExists(workspaceId: UUID) -> Bool
}

@MainActor
public protocol TaskBoundWorktreeProvisioning: AnyObject {
    func provision(projectRoot: URL, branchHint: String?, allowDirty: Bool) async throws
        -> TaskWorktreeProvisionResult
    func teardown(workspaceId: UUID?, worktreePath: String, projectRoot: URL) async throws
}

public enum TaskLifecycleError: Error, Equatable, LocalizedError {
    case taskNotFound(UUID)
    case alreadyBound(UUID)
    case notBound(UUID)
    case provisionInFlight(UUID)
    case provisionFailed(String)

    public var errorDescription: String? {
        switch self {
        case .taskNotFound(let id):
            return String(
                localized: "tasks.lifecycle.error.taskNotFound",
                defaultValue: "Task not found: \(id.uuidString)",
                table: "TermLoop"
            )
        case .alreadyBound:
            return String(
                localized: "tasks.lifecycle.error.alreadyBound",
                defaultValue: "Task already has a worktree.",
                table: "TermLoop"
            )
        case .notBound:
            return String(
                localized: "tasks.lifecycle.error.notBound",
                defaultValue: "Task is not bound to a worktree.",
                table: "TermLoop"
            )
        case .provisionInFlight:
            return String(
                localized: "tasks.lifecycle.error.provisionInFlight",
                defaultValue: "Task worktree provisioning is already in progress.",
                table: "TermLoop"
            )
        case .provisionFailed(let reason):
            return TaskProvisionFailureReason.localizedDisplayText(for: reason)
        }
    }
}

@MainActor
public final class TaskLifecycleCoordinator {
    private let store: TaskBoardStore
    private let workspaces: TaskBoundWorkspaceMetadataStoring
    private let worktrees: TaskBoundWorktreeProvisioning

    public init(
        store: TaskBoardStore,
        workspaces: TaskBoundWorkspaceMetadataStoring,
        worktrees: TaskBoundWorktreeProvisioning
    ) {
        self.store = store
        self.workspaces = workspaces
        self.worktrees = worktrees
    }

    // MARK: - Create / archive

    @discardableResult
    public func createTask(title: String, columnId: TaskColumnId, brief: String? = nil) throws -> UUID {
        let rank = nextRank(in: columnId)
        let task = TaskRecord(
            projectId: store.projectId,
            title: title,
            brief: brief,
            columnId: columnId,
            rank: rank
        )
        store.mutate { file in
            file.tasks.append(task)
            _ = TaskBoardStore.rebalanceColumnIfNeeded(columnId, in: &file)
            return true
        }
        try store.saveNow()
        return task.id
    }

    public func archiveTask(_ id: UUID) throws {
        let task = try requireTask(id)
        try mutateTask(id) { $0.archivedAt = Date(); $0.updatedAt = Date() }
        try store.saveNow()
        DevServerRunCoordinator.shared.stopTaskRunsAndCleanup(
            projectId: store.projectId,
            task: task,
            projectRoot: store.projectRoot,
            reason: "archive"
        )
    }

    public func restoreTask(_ id: UUID) throws {
        guard try requireTask(id).archivedAt != nil else { return }
        try mutateTask(id) { task in
            task.archivedAt = nil
            task.updatedAt = Date()
        }
        try store.saveNow()
    }

    public func deleteTask(_ id: UUID) throws {
        let task = try requireTask(id)
        _ = store.mutate { file in
            guard file.tasks.contains(where: { $0.id == id }) else { return false }
            file.tasks.removeAll { $0.id == id }
            return true
        }
        try store.saveNow()
        DevServerRunCoordinator.shared.stopTaskRunsAndCleanup(
            projectId: store.projectId,
            task: task,
            projectRoot: store.projectRoot,
            reason: "delete"
        )
    }

    // MARK: - Column move

    public func moveColumn(taskId: UUID, to columnId: TaskColumnId) async throws {
        #if DEBUG
        print("TaskLifecycleCoordinator.moveColumn taskId=\(taskId) → \(columnId)")
        #endif
        guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
            #if DEBUG
            print("TaskLifecycleCoordinator.moveColumn: task missing")
            #endif
            return
        }
        guard task.columnId != columnId else { return }
        guard task.provisionState != .pending else {
            #if DEBUG
            print("TaskLifecycleCoordinator.moveColumn: ignored pending task")
            #endif
            throw TaskLifecycleError.provisionInFlight(taskId)
        }
        // Compute new rank OUTSIDE the mutate closure — `nextRank` reads
        // store.fileSnapshot(), and Swift's exclusive-access checker traps
        // when a read happens during an in-flight inout modification.
        let newRank = nextRank(in: columnId)
        try mutateTask(taskId) { t in
            t.columnId = columnId
            t.rank = newRank
            t.updatedAt = Date()
        }
        rebalanceColumnIfNeeded(columnId)
        try store.saveNow()
    }

    // MARK: - Bind (Todo → In Progress)

    public func bindWorktree(
        taskId: UUID,
        branchHint: String? = nil,
        allowDirty: Bool = false
    ) async throws {
        let task = try requireTask(taskId)
        guard task.provisionState != .pending else {
            throw TaskLifecycleError.provisionInFlight(taskId)
        }
        let priorColumn = task.columnId
        let expectedGeneration = task.bindingGeneration
        try mutateTask(taskId) { t in
            t.provisionState = .pending
            t.updatedAt = Date()
        }
        try store.saveNow()

        let result: TaskWorktreeProvisionResult
        do {
            result = try await worktrees.provision(
                projectRoot: store.projectRoot,
                branchHint: branchHint ?? defaultBranchHint(for: task),
                allowDirty: allowDirty
            )
        } catch {
            guard try failBindingIfCurrent(
                taskId: taskId,
                expectedGeneration: expectedGeneration,
                priorColumn: priorColumn,
                error: error
            ) else { return }
            throw TaskLifecycleError.provisionFailed(failureReason(from: error))
        }

        guard isCurrentBindingAttempt(taskId: taskId, generation: expectedGeneration) else {
            guard result.createdWorktree else { return }
            try? await worktrees.teardown(
                workspaceId: result.workspaceId,
                worktreePath: result.worktreePath,
                projectRoot: store.projectRoot
            )
            return
        }

        do {
            try workspaces.setBinding(
                workspaceId: result.workspaceId,
                branch: result.branch,
                path: result.worktreePath
            )
        } catch {
            guard try failBindingIfCurrent(
                taskId: taskId,
                expectedGeneration: expectedGeneration,
                priorColumn: priorColumn,
                error: error
            ) else { return }
            throw TaskLifecycleError.provisionFailed(failureReason(from: error))
        }

        try mutateTask(taskId) { t in
            t.workspaceId = result.workspaceId
            t.branch = result.branch
            t.worktreePath = result.worktreePath
            t.ownsWorktree = result.createdWorktree
            t.bindingGeneration += 1
            t.provisionState = .ready
            t.updatedAt = Date()
        }
        try store.saveNow()
        bindRemoteMetadataIfNeeded(task: task, result: result)
        if let oldPath = task.worktreePath, oldPath != result.worktreePath {
            DevServerRunCoordinator.shared.stopTaskRunsAndCleanup(
                projectId: store.projectId,
                task: task,
                projectRoot: store.projectRoot,
                reason: "worktree_migration"
            )
        }
    }

    public func bindExistingWorktree(
        taskId: UUID,
        workspaceId: UUID,
        branch: String,
        worktreePath: String,
        ownsWorktree: Bool
    ) throws {
        let current = try requireTask(taskId)
        guard current.provisionState != .pending else {
            throw TaskLifecycleError.provisionInFlight(taskId)
        }
        guard workspaces.workspaceExists(workspaceId: workspaceId) else {
            throw TaskLifecycleError.provisionFailed(
                String(localized: "tasks.provision.failure.workspaceMissing",
                       defaultValue: "Created workspace is no longer available.",
                       table: "TermLoop")
            )
        }

        try workspaces.setBinding(
            workspaceId: workspaceId,
            branch: branch,
            path: worktreePath
        )
        try mutateTask(taskId) { t in
            t.workspaceId = workspaceId
            t.branch = branch
            t.worktreePath = worktreePath
            t.ownsWorktree = ownsWorktree
            t.bindingGeneration += 1
            t.provisionState = .ready
            t.updatedAt = Date()
        }
        try store.saveNow()
        bindRemoteMetadataIfNeeded(
            task: current,
            result: TaskWorktreeProvisionResult(
                workspaceId: workspaceId,
                branch: branch,
                worktreePath: worktreePath,
                createdWorktree: false
            )
        )
        if let oldPath = current.worktreePath, oldPath != worktreePath {
            DevServerRunCoordinator.shared.stopTaskRunsAndCleanup(
                projectId: store.projectId,
                task: current,
                projectRoot: store.projectRoot,
                reason: "worktree_migration"
            )
        }
    }

    @discardableResult
    public func ensureTaskSpecFile(taskId: UUID) throws -> String {
        let task = try requireTask(taskId)
        let path = try TaskMarkdownFileWriter.ensureTaskSpec(
            task: task,
            columnTitle: store.columnTitle(for: task.columnId),
            projectRoot: store.projectRoot
        )
        try mutateTask(taskId) { t in
            if t.taskFilePath != path {
                t.taskFilePath = path
                t.updatedAt = Date()
            }
        }
        try store.saveNow()
        return path
    }

    // MARK: - Internals

    private func requireTask(_ id: UUID) throws -> TaskRecord {
        guard let t = store.fileSnapshot().tasks.first(where: { $0.id == id }) else {
            throw TaskLifecycleError.taskNotFound(id)
        }
        return t
    }

    private func mutateTask(_ id: UUID, _ block: (inout TaskRecord) -> Void) throws {
        var found = false
        store.mutate { file in
            if let idx = file.tasks.firstIndex(where: { $0.id == id }) {
                let old = file.tasks[idx]
                block(&file.tasks[idx])
                found = true
                return file.tasks[idx] != old
            }
            return false
        }
        if !found { throw TaskLifecycleError.taskNotFound(id) }
    }

    private func rebalanceColumnIfNeeded(_ columnId: TaskColumnId) {
        _ = store.mutate { file in
            TaskBoardStore.rebalanceColumnIfNeeded(columnId, in: &file)
        }
    }

    private func failBindingIfCurrent(
        taskId: UUID,
        expectedGeneration: Int,
        priorColumn: TaskColumnId,
        error: Error
    ) throws -> Bool {
        guard isCurrentBindingAttempt(taskId: taskId, generation: expectedGeneration) else {
            return false
        }
        let persistedReason = failureReason(from: error)
        let revertedColumn: TaskColumnId = (priorColumn == .inProgress) ? .todo : priorColumn
        // Pre-compute outside the mutate closure (exclusive-access rule).
        let newRank = nextRank(in: revertedColumn)
        try mutateTask(taskId) { t in
            t.columnId = revertedColumn
            t.rank = newRank
            t.provisionState = .failed(reason: persistedReason)
            t.updatedAt = Date()
        }
        rebalanceColumnIfNeeded(revertedColumn)
        try store.saveNow()
        return true
    }

    private func isCurrentBindingAttempt(taskId: UUID, generation: Int) -> Bool {
        guard let current = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
            return false
        }
        return current.bindingGeneration == generation
    }

    private func failureReason(from error: Error) -> String {
        if case let TaskLifecycleError.provisionFailed(reason) = error {
            return reason
        }
        return String(describing: error)
    }

    private func bindRemoteMetadataIfNeeded(
        task: TaskRecord,
        result: TaskWorktreeProvisionResult
    ) {
        guard let reference = task.remoteWorkItem else { return }
        WorktreeRemoteItemBindingStore.shared.bind(reference, forPath: result.worktreePath)
        let snapshot = RemoteWorkItemSnapshotStore.shared.snapshot(for: reference)
        WorkspaceMetadataStore.shared.setAssignedTicket(
            WorkspaceMetadataStore.AssignedTicket(
                providerName: reference.provider.displayLabel,
                key: reference.key,
                title: snapshot?.title ?? task.title,
                status: snapshot?.statusLabel ?? task.remoteStatusLabel,
                url: snapshot?.reference.url ?? reference.url
            ),
            forWorkspaceId: result.workspaceId
        )
    }

    private func nextRank(in column: TaskColumnId) -> String {
        let existing = store.fileSnapshot().tasks
            .filter { $0.columnId == column && $0.archivedAt == nil }
            .map(\.rank)
            .sorted()
        guard let last = existing.last else { return TaskRanking.initial() }
        return TaskRanking.after(last)
    }

    private func defaultBranchHint(for task: TaskRecord) -> String {
        if let branch = normalizedNonEmpty(task.branch) {
            return branch
        }
        if let key = task.remoteWorkItem?.key,
           let component = branchComponent(from: key) {
            return "feature/\(component)"
        }
        return slugFrom(title: task.title)
    }

    private func slugFrom(title: String) -> String {
        let lower = title.lowercased()
        let allowed = lower.unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "-" }
        let collapsed = String(allowed)
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
        let slug = collapsed.isEmpty ? "task" : collapsed
        return "feature/\(slug)-\(UUID().uuidString.prefix(4))"
    }

    private func branchComponent(from value: String) -> String? {
        let allowed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            .unicodeScalars
            .map { scalar -> Character in
                if CharacterSet.alphanumerics.contains(scalar) ||
                    CharacterSet(charactersIn: "-_.").contains(scalar) {
                    return Character(scalar)
                }
                return "-"
            }
        let component = String(allowed)
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
            .trimmingCharacters(in: CharacterSet(charactersIn: ".-_"))
        return component.isEmpty ? nil : component
    }

    private func normalizedNonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension TaskLifecycleCoordinator {
    /// Cancel an in-flight or completed bind. Implements ignore-and-cleanup:
    /// bumps `bindingGeneration` immediately so any stale async completion is ignored,
    /// then attempts teardown of the underlying worktree if one already exists.
    public func cancelBinding(taskId: UUID) throws {
        let task = try requireTask(taskId)
        // Pre-compute outside the mutate closure (exclusive-access rule).
        let newRank = nextRank(in: .todo)
        try mutateTask(taskId) { t in
            t.bindingGeneration += 1
            t.provisionState = .none
            t.workspaceId = nil
            t.worktreePath = nil
            t.branch = nil
            t.columnId = .todo
            t.rank = newRank
            t.updatedAt = Date()
        }
        rebalanceColumnIfNeeded(.todo)
        try store.saveNow()
        DevServerRunCoordinator.shared.stopTaskRunsAndCleanup(
            projectId: store.projectId,
            task: task,
            projectRoot: store.projectRoot,
            reason: "cancel_binding"
        )

        if task.workspaceId != nil || (task.ownsWorktree && task.worktreePath != nil) {
            // Fire-and-forget cleanup. Failure leaves a repair banner on next reconcile.
            _Concurrency.Task { [weak self] in
                guard let self else { return }
                if let workspaceId = task.workspaceId {
                    do {
                        try self.workspaces.clearBinding(workspaceId: workspaceId)
                    } catch {
                        #if DEBUG
                        print("TaskLifecycleCoordinator.cancelBinding clearBinding failed: \(error)")
                        #endif
                    }
                }
                if task.ownsWorktree,
                   let path = task.worktreePath {
                    do {
                        try await self.worktrees.teardown(
                            workspaceId: task.workspaceId,
                            worktreePath: path,
                            projectRoot: self.store.projectRoot
                        )
                    } catch {
                        #if DEBUG
                        print("TaskLifecycleCoordinator.cancelBinding teardown failed: \(error)")
                        #endif
                    }
                }
            }
        }
    }
}

extension TaskLifecycleCoordinator {
    /// Update brief (or other text fields) — debounced save, last-write-wins
    /// across windows.
    public func updateBrief(taskId: UUID, brief: String?) throws {
        let normalized = brief?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmptyTaskLifecycleString
        guard try requireTask(taskId).brief != normalized else { return }
        try mutateTask(taskId) { $0.brief = normalized; $0.updatedAt = Date() }
        store.scheduleSave()
    }

    public func updateTitle(taskId: UUID, title: String) throws {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        guard try requireTask(taskId).title != normalized else { return }
        try mutateTask(taskId) { $0.title = normalized; $0.updatedAt = Date() }
        store.scheduleSave()
    }

    /// Unbind without removing the worktree (user used "Unbind" from repair banner).
    public func unbindWorktree(taskId: UUID) throws {
        let task = try requireTask(taskId)
        try mutateTask(taskId) { t in
            t.workspaceId = nil
            t.worktreePath = nil
            t.branch = nil
            t.ownsWorktree = false
            t.bindingGeneration += 1
            t.provisionState = .none
            t.updatedAt = Date()
        }
        try store.saveNow()
        DevServerRunCoordinator.shared.stopTaskRunsAndCleanup(
            projectId: store.projectId,
            task: task,
            projectRoot: store.projectRoot,
            reason: "unbind"
        )
    }
}

extension TaskLifecycleCoordinator {
    @discardableResult
    func upsertRemoteItemBinding(
        reference: RemoteWorkItemReference,
        snapshot: RemoteWorkItemSnapshot? = nil,
        workspaceId: UUID?,
        worktreePath: String,
        branch: String?,
        at date: Date = Date()
    ) throws -> UUID? {
        guard let resolvedPath = TaskPathNormalization.resolveDisplayAndKey(
            worktreePath,
            relativeTo: store.projectRoot
        ) else {
            return nil
        }

        let effectiveReference = snapshot?.reference ?? reference
        let trimmedBranch = branch?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmptyTaskLifecycleString
        var affectedTaskId: UUID?
        var createdInProgressTask = false

        let changed = store.mutate { file in
            var didChange = false
            let activeIndexes = file.tasks.indices.filter { file.tasks[$0].archivedAt == nil }
            let pathIndex = activeIndexes.first { idx in
                Self.normalizedTaskPathKey(
                    file.tasks[idx].worktreePath,
                    relativeTo: store.projectRoot
                ) == resolvedPath.keyPath
            }
            let workspaceIndex = workspaceId.flatMap { workspaceId in
                activeIndexes.first { file.tasks[$0].workspaceId == workspaceId }
            }
            let remoteIndex = activeIndexes.first { idx in
                file.tasks[idx].remoteWorkItem?.representsSameRemoteItem(as: effectiveReference) == true
            }

            if let idx = pathIndex ?? workspaceIndex ?? remoteIndex {
                let old = file.tasks[idx]
                Self.applyRemoteItemBinding(
                    to: &file.tasks[idx],
                    reference: effectiveReference,
                    snapshot: snapshot,
                    workspaceId: workspaceId,
                    resolvedPath: resolvedPath,
                    branch: trimmedBranch,
                    date: date
                )
                affectedTaskId = file.tasks[idx].id
                didChange = file.tasks[idx] != old
            } else {
                let rank = Self.nextRank(in: .inProgress, file: file)
                let status = snapshot?.statusLabel?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nonEmptyTaskLifecycleString
                let task = TaskRecord(
                    projectId: store.projectId,
                    title: Self.remoteBindingTitle(reference: effectiveReference, snapshot: snapshot),
                    origin: .remote,
                    remoteWorkItem: effectiveReference,
                    remoteStatusLabel: status,
                    lastRemoteSyncAt: snapshot?.fetchedAt,
                    columnId: .inProgress,
                    rank: rank,
                    workspaceId: workspaceId,
                    worktreePath: resolvedPath.displayPath,
                    branch: trimmedBranch,
                    ownsWorktree: false,
                    bindingGeneration: 1,
                    provisionState: .ready,
                    createdAt: date,
                    updatedAt: date
                )
                file.tasks.append(task)
                affectedTaskId = task.id
                createdInProgressTask = true
                didChange = true
            }

            if createdInProgressTask {
                didChange = TaskBoardStore.rebalanceColumnIfNeeded(.inProgress, in: &file) || didChange
            }
            return didChange
        }

        if changed {
            try store.saveNow()
        }

        if let snapshot, let affectedTaskId {
            let taskFilePath = try TaskMarkdownFileWriter.writeRemoteSnapshot(
                snapshot,
                taskId: affectedTaskId,
                projectRoot: store.projectRoot
            )
            let filePathChanged = store.mutate { file in
                guard let idx = file.tasks.firstIndex(where: { $0.id == affectedTaskId }),
                      file.tasks[idx].taskFilePath != taskFilePath else {
                    return false
                }
                file.tasks[idx].taskFilePath = taskFilePath
                file.tasks[idx].updatedAt = Date()
                return true
            }
            if filePathChanged {
                try store.saveNow()
            }
        }

        return affectedTaskId
    }

    private static func applyRemoteItemBinding(
        to task: inout TaskRecord,
        reference: RemoteWorkItemReference,
        snapshot: RemoteWorkItemSnapshot?,
        workspaceId: UUID?,
        resolvedPath: TaskResolvedWorktreePath,
        branch: String?,
        date: Date
    ) {
        let original = task
        let priorWorkspaceId = task.workspaceId
        let priorWorktreePath = task.worktreePath
        let priorBranch = task.branch
        let priorReference = task.remoteWorkItem

        if let snapshotTitle = snapshot?.title
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmptyTaskLifecycleString {
            task.title = snapshotTitle
        } else if priorReference?.representsSameRemoteItem(as: reference) != true {
            task.title = reference.key
        }

        task.origin = .remote
        task.remoteWorkItem = reference
        if let snapshot {
            task.remoteStatusLabel = snapshot.statusLabel?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .nonEmptyTaskLifecycleString
            task.lastRemoteSyncAt = snapshot.fetchedAt
        } else if priorReference?.representsSameRemoteItem(as: reference) != true {
            task.remoteStatusLabel = nil
            task.lastRemoteSyncAt = nil
        }

        task.workspaceId = workspaceId ?? task.workspaceId
        task.worktreePath = resolvedPath.displayPath
        task.branch = branch ?? task.branch
        if task.provisionState != .pending {
            task.provisionState = .ready
        }

        if task.workspaceId != priorWorkspaceId
            || task.worktreePath != priorWorktreePath
            || task.branch != priorBranch {
            task.bindingGeneration += 1
        }
        if task != original {
            task.updatedAt = date
        }
    }

    private static func remoteBindingTitle(
        reference: RemoteWorkItemReference,
        snapshot: RemoteWorkItemSnapshot?
    ) -> String {
        snapshot?.title
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmptyTaskLifecycleString
            ?? reference.key
    }

    private static func nextRank(in columnId: TaskColumnId, file: TaskBoardFile) -> String {
        let existing = file.tasks
            .filter { $0.columnId == columnId && $0.archivedAt == nil }
            .map(\.rank)
            .sorted()
        guard let last = existing.last else { return TaskRanking.initial() }
        return TaskRanking.after(last)
    }

    private static func normalizedTaskPathKey(_ path: String?, relativeTo projectRoot: URL) -> String? {
        TaskPathNormalization.resolveDisplayAndKey(path, relativeTo: projectRoot)?.keyPath
    }
}

@MainActor
enum TaskWorktreeRemoteItemMaterializer {
    @discardableResult
    static func materialize(
        reference: RemoteWorkItemReference,
        snapshot: RemoteWorkItemSnapshot? = nil,
        workspaceIds: [UUID],
        worktreePath: String,
        reason: String
    ) -> UUID? {
        guard let projectId = resolveProjectId(workspaceIds: workspaceIds, worktreePath: worktreePath),
              let store = TaskBoardStoreProvider.shared.store(for: projectId) else {
            return nil
        }

        let metadata = WorkspaceMetadataStore.shared
        let resolvedPath = TaskPathNormalization
            .resolveDisplayAndKey(worktreePath, relativeTo: store.projectRoot)?
            .displayPath ?? worktreePath
        let workspaceId = preferredWorkspaceId(
            workspaceIds: workspaceIds,
            projectId: projectId,
            worktreePath: resolvedPath
        )
        let branch = workspaceId.flatMap { metadata.branch(forWorkspaceId: $0) }

        do {
            let taskId = try TaskLifecycleCoordinator.makeForProject(store: store)
                .upsertRemoteItemBinding(
                    reference: reference,
                    snapshot: snapshot,
                    workspaceId: workspaceId,
                    worktreePath: resolvedPath,
                    branch: branch
                )
            TaskBoardReconcileScheduler.shared.request(projectId: projectId, reason: reason)
            return taskId
        } catch {
            NSLog("[Tasks] remote item task materialize failed key=\(reference.key) reason=\(reason) error=\(String(describing: error))")
            return nil
        }
    }

    private static func resolveProjectId(workspaceIds: [UUID], worktreePath: String) -> UUID? {
        let metadata = WorkspaceMetadataStore.shared
        if let projectId = workspaceIds.compactMap({ metadata.projectId(forWorkspaceId: $0) }).first {
            return projectId
        }
        if let project = ProjectStore.shared.project(containingPath: worktreePath) {
            return project.id
        }
        return ProjectStore.shared.activeProjectId
    }

    private static func preferredWorkspaceId(
        workspaceIds: [UUID],
        projectId: UUID,
        worktreePath: String
    ) -> UUID? {
        let metadata = WorkspaceMetadataStore.shared
        if let workspaceId = workspaceIds.first(where: { metadata.projectId(forWorkspaceId: $0) == projectId }) {
            return workspaceId
        }
        if let workspaceId = workspaceIds.first {
            return workspaceId
        }
        return metadata.workspaceIds(withWorktreePath: worktreePath, projectId: projectId).first
    }
}

private extension String {
    var nonEmptyTaskLifecycleString: String? { isEmpty ? nil : self }
}

extension TaskLifecycleCoordinator {
    @discardableResult
    public func reconcileWorkspaceBindings(
        projectRoot: URL,
        snapshot: TaskWorkspaceListingSnapshot
    ) throws -> TaskBoardReconcileSummary {
        let beforeTasks = store.fileSnapshot().tasks
        let descriptors = snapshot.descriptors
        // Use bucketed dictionaries. Duplicate metadata rows are corruption;
        // first wins so reconcile keeps running and leaves repair to the UI.
        var descriptorByKey: [TaskWorkspaceReconcileKey: TaskWorkspaceDescriptor] = [:]
        var descriptorByWorkspaceId: [UUID: TaskWorkspaceDescriptor] = [:]
        for d in descriptors {
            guard let resolved = TaskPathNormalization.resolveDisplayAndKey(d.worktreePath, relativeTo: projectRoot) else {
                continue
            }
            let key = TaskWorkspaceReconcileKey(projectId: store.projectId, normalizedPath: resolved.keyPath)
            if descriptorByKey[key] == nil {
                descriptorByKey[key] = d
            }
            if let workspaceId = d.workspaceId, descriptorByWorkspaceId[workspaceId] == nil {
                descriptorByWorkspaceId[workspaceId] = d
            }
        }

        var prunedCount = 0
        var updatedCount = 0
        var interruptedCount = 0
        var archivedCount = 0
        var detachedCount = 0
        var missingCount = 0
        var importedCount = 0

        let changed = store.mutate { file in
            var changed = false

            let beforePrune = file.tasks.count
            file.tasks.removeAll { task in
                shouldPruneImplicitWorktreeImport(
                    task,
                    projectRoot: projectRoot,
                    descriptorByKey: descriptorByKey
                )
            }
            prunedCount = beforePrune - file.tasks.count
            changed = changed || prunedCount > 0

            // Prefer workspace-id matches, then recover by normalized worktree
            // path. Non-authoritative listings never mark bound tasks missing.
            for i in file.tasks.indices {
                var t = file.tasks[i]
                guard t.archivedAt == nil else { continue }

                let pathKey: TaskWorkspaceReconcileKey? = t.worktreePath.map {
                    TaskPathNormalization.resolveDisplayAndKey($0, relativeTo: projectRoot).map {
                        TaskWorkspaceReconcileKey(projectId: store.projectId, normalizedPath: $0.keyPath)
                    }
                }
                .flatMap { $0 }
                let workspaceDescriptor = t.workspaceId.flatMap { descriptorByWorkspaceId[$0] }
                let pathDescriptor = pathKey.flatMap { descriptorByKey[$0] }
                let descriptor = workspaceDescriptor ?? pathDescriptor

                if let descriptor {
                    let original = t
                    if let workspaceId = descriptor.workspaceId {
                        t.workspaceId = workspaceId
                    } else if workspaceDescriptor == nil {
                        t.workspaceId = nil
                    }
                    t.branch = descriptor.branch ?? t.branch
                    t.worktreePath = descriptor.worktreePath
                    if shouldMarkReadyAfterDescriptorMatch(t.provisionState) {
                        t.provisionState = .ready
                    }
                    if t != original {
                        t.updatedAt = Date()
                        file.tasks[i] = t
                        updatedCount += 1
                        changed = true
                    }
                    continue
                }

                guard t.workspaceId != nil || t.worktreePath != nil else {
                    if case .pending = t.provisionState {
                        t.provisionState = .failed(reason: TaskProvisionFailureReason.interrupted)
                        t.updatedAt = Date()
                        file.tasks[i] = t
                        interruptedCount += 1
                        changed = true
                    }
                    continue
                }

                guard snapshot.isAuthoritative else { continue }

                if shouldArchiveMissingWorktreeTask(t) {
                    t.archivedAt = Date()
                    t.updatedAt = Date()
                    file.tasks[i] = t
                    archivedCount += 1
                    changed = true
                } else if shouldDetachMissingWorktreeTask(t) {
                    let original = t
                    t.workspaceId = nil
                    t.worktreePath = nil
                    t.branch = nil
                    t.bindingGeneration += 1
                    t.provisionState = .none
                    t.updatedAt = Date()
                    if t != original {
                        file.tasks[i] = t
                        detachedCount += 1
                        changed = true
                    }
                } else if !t.provisionState.isFailed {
                    t.provisionState = .failed(reason: TaskProvisionFailureReason.worktreeMissing)
                    t.updatedAt = Date()
                    file.tasks[i] = t
                    missingCount += 1
                    changed = true
                }
            }

            var existingKeys: Set<TaskWorkspaceReconcileKey> = []
            for task in file.tasks where task.archivedAt == nil {
                guard let path = task.worktreePath else { continue }
                guard let resolved = TaskPathNormalization.resolveDisplayAndKey(path, relativeTo: projectRoot) else {
                    continue
                }
                let key = TaskWorkspaceReconcileKey(projectId: store.projectId, normalizedPath: resolved.keyPath)
                existingKeys.insert(key)
            }

            for (key, d) in descriptorByKey where !existingKeys.contains(key) {
                guard d.canImportTask else { continue }
                let title = d.branch ?? URL(fileURLWithPath: d.worktreePath).lastPathComponent
                let inProgressRanks = file.tasks
                    .filter { $0.columnId == .inProgress && $0.archivedAt == nil }
                    .map(\.rank)
                    .sorted()
                let rank = inProgressRanks.last.map(TaskRanking.after) ?? TaskRanking.initial()
                let task = TaskRecord(
                    projectId: store.projectId,
                    title: title,
                    origin: .worktree,
                    columnId: .inProgress,
                    rank: rank,
                    workspaceId: d.workspaceId,
                    worktreePath: d.worktreePath,
                    branch: d.branch,
                    bindingGeneration: 1,
                    provisionState: .ready
                )
                file.tasks.append(task)
                existingKeys.insert(key)
                importedCount += 1
                changed = true
            }
            if changed {
                _ = TaskBoardStore.rebalanceColumnIfNeeded(.inProgress, in: &file)
            }
            return changed
        }

        if changed {
            try store.saveNow()
            cleanupDevServerRunsForReconciledTasks(beforeTasks: beforeTasks, reason: "reconcile")
        }
        return TaskBoardReconcileSummary(
            projectId: store.projectId,
            descriptorCount: descriptors.count,
            isAuthoritative: snapshot.isAuthoritative,
            changed: changed,
            prunedCount: prunedCount,
            updatedCount: updatedCount,
            interruptedCount: interruptedCount,
            archivedCount: archivedCount,
            detachedCount: detachedCount,
            missingCount: missingCount,
            importedCount: importedCount
        )
    }

    private func cleanupDevServerRunsForReconciledTasks(beforeTasks: [TaskRecord], reason: String) {
        let afterById = Dictionary(uniqueKeysWithValues: store.fileSnapshot().tasks.map { ($0.id, $0) })
        var cleaned = Set<UUID>()
        for before in beforeTasks {
            guard cleaned.insert(before.id).inserted,
                  before.archivedAt == nil,
                  before.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { continue }
            let after = afterById[before.id]
            let shouldCleanup = after == nil
                || after?.archivedAt != nil
                || after?.worktreePath != before.worktreePath
                || (after?.worktreePath == nil && before.worktreePath != nil)
            guard shouldCleanup else { continue }
            DevServerRunCoordinator.shared.stopTaskRunsAndCleanup(
                projectId: store.projectId,
                task: before,
                projectRoot: store.projectRoot,
                reason: reason
            )
        }
    }

    private func shouldMarkReadyAfterDescriptorMatch(_ state: TaskProvisionState) -> Bool {
        switch state {
        case .ready:
            return false
        case .none, .pending:
            return true
        case .failed(let reason):
            return reason == TaskProvisionFailureReason.worktreeMissing
                || reason == TaskProvisionFailureReason.interrupted
                || reason == TaskProvisionFailureReason.provisioningUnavailable
        }
    }

    private func shouldArchiveMissingWorktreeTask(_ task: TaskRecord) -> Bool {
        task.remoteWorkItem == nil
    }

    private func shouldDetachMissingWorktreeTask(_ task: TaskRecord) -> Bool {
        task.remoteWorkItem != nil
    }

    private func shouldPruneImplicitWorktreeImport(
        _ task: TaskRecord,
        projectRoot: URL,
        descriptorByKey: [TaskWorkspaceReconcileKey: TaskWorkspaceDescriptor]
    ) -> Bool {
        guard task.archivedAt == nil,
              task.origin == .worktree,
              task.remoteWorkItem == nil,
              task.bindingGeneration == 1,
              case .ready = task.provisionState,
              let worktreePath = task.worktreePath else {
            return false
        }
        guard let resolved = TaskPathNormalization.resolveDisplayAndKey(worktreePath, relativeTo: projectRoot) else {
            return false
        }
        let key = TaskWorkspaceReconcileKey(projectId: store.projectId, normalizedPath: resolved.keyPath)
        let importedTitle = task.branch ?? URL(fileURLWithPath: worktreePath).lastPathComponent
        guard task.title == importedTitle else { return false }
        if descriptorByKey[key]?.canImportTask == false {
            return true
        }
        guard descriptorByKey[key] == nil else { return false }
        return WorktreeResolver.worktreeRoot(
            containing: worktreePath,
            projectFolder: projectRoot.path
        ) == nil
    }
}

private struct TaskWorkspaceReconcileKey: Hashable {
    let projectId: UUID
    let normalizedPath: String
}
