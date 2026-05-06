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

    public func workspaces(in projectId: UUID) async -> [TaskWorkspaceDescriptor] {
        let store = WorkspaceMetadataStore.shared
        let projectRoot = projectRoot(for: projectId)
        let workspaceIds = store.workspaceIds(inProject: projectId)
        var descriptors: [TaskWorkspaceDescriptor] = workspaceIds.compactMap { workspaceId in
            guard let path = store.worktreePath(forWorkspaceId: workspaceId) else { return nil }
            let metadata = store.metadata(forWorkspaceId: workspaceId)
            return TaskWorkspaceDescriptor(
                workspaceId: workspaceId,
                projectId: projectId,
                branch: metadata.branch,
                worktreePath: path
            )
        }

        // Metadata is not the source of truth for whether a git worktree
        // exists. After restores, metadata cleanup, or external git worktree
        // operations, the physical checkout can be present while no live
        // workspace metadata row points at it. Include `git worktree list`
        // entries so Tasks can recover by path instead of painting every
        // existing branch red as "Worktree missing".
        var seenPaths = Set(descriptors.compactMap {
            TaskPathNormalization.resolveDisplayAndKey($0.worktreePath, relativeTo: projectRoot)?.keyPath
        })
        let gitEntries = await gitWorktreeEntries(projectRoot: projectRoot)
        for entry in gitEntries where !entry.isMain {
            guard WorktreeResolver.worktreeRoot(
                containing: entry.path,
                projectFolder: projectRoot.path
            ) != nil else {
                continue
            }
            guard let resolved = TaskPathNormalization.resolveDisplayAndKey(entry.path, relativeTo: projectRoot),
                  seenPaths.insert(resolved.keyPath).inserted else {
                continue
            }
            descriptors.append(TaskWorkspaceDescriptor(
                workspaceId: nil,
                projectId: projectId,
                branch: entry.branch,
                worktreePath: entry.path
            ))
        }

        return descriptors
    }

    private func gitWorktreeEntries(projectRoot: URL) async -> [GitWorktreeService.ListEntry] {
        if let cached = WorktreeRegistry.shared.cachedSnapshot(projectFolder: projectRoot.path, maximumAge: 30) {
            return cached.entries
        }

        return await withCheckedContinuation { continuation in
            WorktreeRegistry.shared.refresh(projectFolder: projectRoot.path, reason: "tasks.reconcile") { result in
                switch result {
                case .success(let snapshot):
                    continuation.resume(returning: snapshot.entries)
                case .failure:
                    continuation.resume(returning: [])
                }
            }
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
