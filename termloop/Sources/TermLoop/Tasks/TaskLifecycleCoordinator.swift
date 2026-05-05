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
        store.mutate { $0.tasks.append(task) }
        try store.saveNow()
        return task.id
    }

    public func archiveTask(_ id: UUID) throws {
        try mutateTask(id) { $0.archivedAt = Date(); $0.updatedAt = Date() }
        try store.saveNow()
    }

    // MARK: - Column move (with bind side-effect on Todo→InProgress)

    public func moveColumn(taskId: UUID, to columnId: TaskColumnId) async throws {
        let needsBind = try requireTask(taskId).workspaceId == nil && columnId == .inProgress
        try mutateTask(taskId) { task in
            task.columnId = columnId
            task.rank = self.nextRank(in: columnId)
            task.updatedAt = Date()
            if needsBind { task.provisionState = .pending }
        }
        try store.saveNow()
        if needsBind {
            try await bindWorktree(taskId: taskId)
        }
    }

    // MARK: - Bind (Todo → In Progress)

    public func bindWorktree(taskId: UUID) async throws {
        let task = try requireTask(taskId)
        let priorColumn = task.columnId
        do {
            let result = try await worktrees.provision(
                projectRoot: store.projectRoot,
                branchHint: task.branch ?? slugFrom(title: task.title)
            )
            try workspaces.setBinding(
                workspaceId: result.workspaceId,
                branch: result.branch,
                path: result.worktreePath
            )
            try mutateTask(taskId) { t in
                t.workspaceId = result.workspaceId
                t.branch = result.branch
                t.worktreePath = result.worktreePath
                t.bindingGeneration += 1
                t.provisionState = .ready
                t.updatedAt = Date()
            }
            try store.saveNow()
        } catch {
            try mutateTask(taskId) { t in
                t.columnId = priorColumn == .inProgress ? .todo : priorColumn
                t.rank = self.nextRank(in: t.columnId)
                t.provisionState = .failed(reason: String(describing: error))
                t.updatedAt = Date()
            }
            try store.saveNow()
            throw TaskLifecycleError.provisionFailed(String(describing: error))
        }
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
                block(&file.tasks[idx])
                found = true
            }
        }
        if !found { throw TaskLifecycleError.taskNotFound(id) }
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
        try mutateTask(taskId) { t in
            t.bindingGeneration += 1
            t.provisionState = .none
            t.workspaceId = nil
            t.worktreePath = nil
            t.branch = nil
            t.columnId = .todo
            t.rank = self.nextRank(in: .todo)
            t.updatedAt = Date()
        }
        try store.saveNow()

        if let workspaceId = task.workspaceId, let path = task.worktreePath {
            // Fire-and-forget teardown. Failure leaves a repair banner on next reconcile.
            _Concurrency.Task { [weak self] in
                guard let self else { return }
                try? self.workspaces.clearBinding(workspaceId: workspaceId)
                try? await self.worktrees.teardown(workspaceId: workspaceId, worktreePath: path)
            }
        }
    }
}
