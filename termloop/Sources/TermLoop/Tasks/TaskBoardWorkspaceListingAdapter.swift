// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Adapter bridging `TaskBoardWorkspaceListing` to the existing
/// `WorkspaceMetadataStore` + `ProjectStore`. Read-only — reconciler uses this
/// to discover orphan worktrees and validate task bindings.
///
/// Registered into `TaskBoardStoreProvider.shared.workspaceLister` at app
/// startup (via `TaskBoardReconcileHook.bootstrap()`).
@MainActor
public final class TaskBoardWorkspaceListingAdapter: TaskBoardWorkspaceListing {
    public static let shared = TaskBoardWorkspaceListingAdapter()
    private init() {}

    public func workspaces(in projectId: UUID) -> [TaskWorkspaceDescriptor] {
        let store = WorkspaceMetadataStore.shared
        let workspaceIds = store.workspaceIds(inProject: projectId)
        return workspaceIds.compactMap { workspaceId in
            guard let path = store.worktreePath(forWorkspaceId: workspaceId) else { return nil }
            let metadata = store.metadata(forWorkspaceId: workspaceId)
            return TaskWorkspaceDescriptor(
                workspaceId: workspaceId,
                projectId: projectId,
                branch: metadata.branch,
                worktreePath: path
            )
        }
    }

    public func projectRoot(for projectId: UUID) -> URL {
        if let project = ProjectStore.shared.project(id: projectId) {
            return URL(fileURLWithPath: project.folderPath, isDirectory: true)
        }
        // Fallback — should not happen in practice since the caller
        // already has a valid TaskBoardStore for this projectId.
        return URL(fileURLWithPath: NSTemporaryDirectory())
    }
}
