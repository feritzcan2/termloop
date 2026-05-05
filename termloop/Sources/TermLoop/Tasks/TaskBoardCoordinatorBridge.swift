// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Minimal bridge from the lifecycle coordinator's workspace-metadata protocol
/// to the existing `WorkspaceMetadataStore`. v1 supports queries and the
/// branch+path bind path; cleanup goes through the existing branch=nil API.
@MainActor
public final class TaskBoardWorkspaceMetadataBridge: TaskBoundWorkspaceMetadataStoring {
    public static let shared = TaskBoardWorkspaceMetadataBridge()
    private init() {}

    public func setBinding(workspaceId: UUID, branch: String, path: String) throws {
        WorkspaceMetadataStore.shared.setBranch(branch, worktreePath: path, forWorkspaceId: workspaceId)
    }

    public func clearBinding(workspaceId: UUID) throws {
        WorkspaceMetadataStore.shared.setBranch(nil, worktreePath: nil, forWorkspaceId: workspaceId)
    }

    public func workspaceExists(workspaceId: UUID) -> Bool {
        WorkspaceMetadataStore.shared.hasMetadata(forWorkspaceId: workspaceId)
    }
}

/// v1 stub — `bindWorktree` (the only consumer of provision) throws if called.
/// createTask, moveColumn (Todo→Backlog), brief edits, archive, and Backlog
/// management all work without provisioning. Real provisioning bridge is a
/// follow-up: needs to call `WorktreeCoordinator.attach` with the project
/// root + a fresh slug, returning the resulting workspaceId.
@MainActor
public final class TaskBoardWorktreeProvisioningStub: TaskBoundWorktreeProvisioning {
    public static let shared = TaskBoardWorktreeProvisioningStub()
    private init() {}

    public func provision(projectRoot: URL, branchHint: String?) async throws
        -> TaskWorktreeProvisionResult
    {
        throw TaskLifecycleError.provisionFailed(
            "Worktree provisioning not yet wired. Spawn the worktree from the existing Work-tab UI for now."
        )
    }

    public func teardown(workspaceId: UUID, worktreePath: String) async throws {
        // No-op — without provisioning we never created anything to tear down.
    }
}

/// Convenience: build a coordinator for a given store using the v1 bridges.
@MainActor
public extension TaskLifecycleCoordinator {
    static func makeForProject(store: TaskBoardStore) -> TaskLifecycleCoordinator {
        TaskLifecycleCoordinator(
            store: store,
            workspaces: TaskBoardWorkspaceMetadataBridge.shared,
            worktrees: TaskBoardWorktreeProvisioningStub.shared
        )
    }
}
