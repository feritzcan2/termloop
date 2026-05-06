// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public struct TaskWorktreeProvisionResult: Equatable, Sendable {
    public let workspaceId: UUID
    public let branch: String
    public let worktreePath: String

    public init(workspaceId: UUID, branch: String, worktreePath: String) {
        self.workspaceId = workspaceId
        self.branch = branch
        self.worktreePath = worktreePath
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
    func provision(projectRoot: URL, branchHint: String?) async throws
        -> TaskWorktreeProvisionResult
    func teardown(workspaceId: UUID, worktreePath: String) async throws
}

public enum TaskLifecycleError: Error, Equatable {
    case taskNotFound(UUID)
    case alreadyBound(UUID)
    case notBound(UUID)
    case provisionInFlight(UUID)
    case provisionFailed(String)
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
        try mutateTask(id) { $0.archivedAt = Date(); $0.updatedAt = Date() }
        try store.saveNow()
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

    public func bindWorktree(taskId: UUID) async throws {
        let task = try requireTask(taskId)
        let priorColumn = task.columnId
        let expectedGeneration = task.bindingGeneration

        let result: TaskWorktreeProvisionResult
        do {
            result = try await worktrees.provision(
                projectRoot: store.projectRoot,
                branchHint: task.branch ?? slugFrom(title: task.title)
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
            try? await worktrees.teardown(
                workspaceId: result.workspaceId,
                worktreePath: result.worktreePath
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
            t.bindingGeneration += 1
            t.provisionState = .ready
            t.updatedAt = Date()
        }
        try store.saveNow()
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

    private func nextRank(in column: TaskColumnId) -> String {
        let existing = store.fileSnapshot().tasks
            .filter { $0.columnId == column && $0.archivedAt == nil }
            .map(\.rank)
            .sorted()
        guard let last = existing.last else { return TaskRanking.initial() }
        return TaskRanking.after(last)
    }

    private func slugFrom(title: String) -> String {
        let lower = title.lowercased()
        let allowed = lower.unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "-" }
        let collapsed = String(allowed)
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
        return "feat/\(collapsed)-\(UUID().uuidString.prefix(4))"
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

        if let workspaceId = task.workspaceId, let path = task.worktreePath {
            // Fire-and-forget teardown. Failure leaves a repair banner on next reconcile.
            _Concurrency.Task { [weak self] in
                guard let self else { return }
                do {
                    try self.workspaces.clearBinding(workspaceId: workspaceId)
                } catch {
                    #if DEBUG
                    print("TaskLifecycleCoordinator.cancelBinding clearBinding failed: \(error)")
                    #endif
                }
                do {
                    try await self.worktrees.teardown(workspaceId: workspaceId, worktreePath: path)
                } catch {
                    #if DEBUG
                    print("TaskLifecycleCoordinator.cancelBinding teardown failed: \(error)")
                    #endif
                }
            }
        }
    }
}

extension TaskLifecycleCoordinator {
    /// Update brief (or other text fields) — debounced save, last-write-wins
    /// across windows.
    public func updateBrief(taskId: UUID, brief: String?) throws {
        try mutateTask(taskId) { $0.brief = brief; $0.updatedAt = Date() }
        store.scheduleSave()
    }

    public func updateTitle(taskId: UUID, title: String) throws {
        try mutateTask(taskId) { $0.title = title; $0.updatedAt = Date() }
        store.scheduleSave()
    }

    /// Unbind without removing the worktree (user used "Unbind" from repair banner).
    public func unbindWorktree(taskId: UUID) throws {
        try mutateTask(taskId) { t in
            t.workspaceId = nil
            t.worktreePath = nil
            t.branch = nil
            t.bindingGeneration += 1
            t.provisionState = .none
            t.updatedAt = Date()
        }
        try store.saveNow()
    }
}
