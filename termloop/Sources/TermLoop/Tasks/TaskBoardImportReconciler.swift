// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public struct TaskWorkspaceDescriptor: Equatable, Sendable {
    public let workspaceId: UUID?
    public let projectId: UUID
    public let branch: String?
    public let worktreePath: String
    /// True only for an explicit import surface. Normal workspace metadata and
    /// physical `git worktree list` entries validate existing task bindings;
    /// they must not materialize board cards by themselves.
    public let canImportTask: Bool

    public init(
        workspaceId: UUID?,
        projectId: UUID,
        branch: String?,
        worktreePath: String,
        canImportTask: Bool = false
    ) {
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.branch = branch
        self.worktreePath = worktreePath
        self.canImportTask = canImportTask
    }
}

public struct TaskWorkspaceListingSnapshot: Equatable, Sendable {
    public let descriptors: [TaskWorkspaceDescriptor]
    public let isAuthoritative: Bool

    public init(descriptors: [TaskWorkspaceDescriptor], isAuthoritative: Bool) {
        self.descriptors = descriptors
        self.isAuthoritative = isAuthoritative
    }
}

public struct TaskBoardReconcileSummary: Equatable, Sendable {
    public let projectId: UUID
    public let descriptorCount: Int
    public let isAuthoritative: Bool
    public let changed: Bool
    public let prunedCount: Int
    public let updatedCount: Int
    public let interruptedCount: Int
    public let archivedCount: Int
    public let detachedCount: Int
    public let missingCount: Int
    public let importedCount: Int
}

@MainActor
public protocol TaskBoardWorkspaceListing: AnyObject {
    func workspaceSnapshot(in projectId: UUID) async -> TaskWorkspaceListingSnapshot
    func projectRoot(for projectId: UUID) -> URL
}

@MainActor
public final class TaskBoardImportReconciler {
    private let store: TaskBoardStore
    private let workspaces: TaskBoardWorkspaceListing

    public init(store: TaskBoardStore, workspaces: TaskBoardWorkspaceListing) {
        self.store = store
        self.workspaces = workspaces
    }

    @discardableResult
    public func run() async throws -> TaskBoardReconcileSummary {
        let projectRoot = workspaces.projectRoot(for: store.projectId)
        let snapshot = await workspaces.workspaceSnapshot(in: store.projectId)
        return try TaskLifecycleCoordinator.makeForProject(store: store).reconcileWorkspaceBindings(
            projectRoot: projectRoot,
            snapshot: snapshot
        )
    }
}
