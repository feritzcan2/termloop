// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
final class TaskDeletionCoordinator {
    struct Options {
        var deleteWorktree: Bool
        var deleteBranch: Bool
        var deleteScratchpad: Bool
    }

    private let store: TaskStore
    private let detachWorktree: (_ taskId: UUID) throws -> Void
    private let deleteBranch: (UUID, String) throws -> Void
    private let snapshotBoundWorkspaces: (UUID) -> [UUID]
    private let setTaskIdOnWorkspace: (UUID, UUID?) -> Void
    private let projectRootProvider: (UUID) -> URL

    init(
        store: TaskStore,
        detachWorktree: @escaping (UUID) throws -> Void,
        deleteBranch: @escaping (UUID, String) throws -> Void,
        snapshotBoundWorkspaces: @escaping (UUID) -> [UUID],
        setTaskIdOnWorkspace: @escaping (UUID, UUID?) -> Void,
        projectRootProvider: @escaping (UUID) -> URL
    ) {
        self.store = store
        self.detachWorktree = detachWorktree
        self.deleteBranch = deleteBranch
        self.snapshotBoundWorkspaces = snapshotBoundWorkspaces
        self.setTaskIdOnWorkspace = setTaskIdOnWorkspace
        self.projectRootProvider = projectRootProvider
    }

    func delete(task: TermLoopTask, options: Options) async throws {
        let boundWorkspaces = snapshotBoundWorkspaces(task.id)

        if options.deleteWorktree {
            try detachWorktree(task.id)

            if options.deleteBranch {
                do { try deleteBranch(task.projectId, task.branch) } catch {
                    NSLog("[TaskDelete] branch delete failed: \(error)")
                }
            }
        }

        if options.deleteScratchpad {
            let dir = projectRootProvider(task.projectId)
                .appendingPathComponent(".termloop/tasks/\(task.id.uuidString)")
            try? FileManager.default.removeItem(at: dir)
        }

        for wsId in boundWorkspaces {
            setTaskIdOnWorkspace(wsId, nil)
        }

        do {
            try store.delete(taskId: task.id, projectId: task.projectId)
        } catch {
            for wsId in boundWorkspaces {
                setTaskIdOnWorkspace(wsId, task.id)
            }
            throw error
        }
    }
}
