// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public struct TaskWorkspaceDescriptor: Equatable, Sendable {
    public let workspaceId: UUID
    public let projectId: UUID
    public let branch: String?
    public let worktreePath: String

    public init(workspaceId: UUID, projectId: UUID, branch: String?, worktreePath: String) {
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.branch = branch
        self.worktreePath = worktreePath
    }
}

@MainActor
public protocol TaskBoardWorkspaceListing: AnyObject {
    func workspaces(in projectId: UUID) -> [TaskWorkspaceDescriptor]
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

    public func run() throws {
        let projectRoot = workspaces.projectRoot(for: store.projectId)
        let descriptors = workspaces.workspaces(in: store.projectId)
        // Use bucketed dictionary, NOT `Dictionary(uniqueKeysWithValues:)` — duplicates would crash.
        // Two metadata records pointing at the same normalized path is corruption; keep first, surface repair banner via reconcile.
        var descriptorByKey: [Key: TaskWorkspaceDescriptor] = [:]
        for d in descriptors {
            let normalized = TaskPathNormalization.normalize(d.worktreePath, relativeTo: projectRoot)
            let key = Key(projectId: store.projectId, normalizedPath: normalized)
            if descriptorByKey[key] == nil {
                descriptorByKey[key] = d
            }
            // Else: duplicate path — first wins; reconcile pass on existing tasks will flag mismatched workspaceIds via repair banner.
        }

        // Validate existing tasks.
        // Use direct workspace-id membership instead of path-keyed lookup —
        // descriptors can be empty during a startup race, which would
        // otherwise mark every bound task as "worktree missing" on every
        // relaunch. If descriptorWorkspaceIds is empty, SKIP validation
        // entirely (we can't trust the listing yet).
        // Self-recovering: a task previously stuck on .failed("worktree
        // missing"/"interrupted") that now resolves cleanly is reset to .ready.
        let descriptorWorkspaceIds = Set(descriptors.map(\.workspaceId))
        if !descriptorWorkspaceIds.isEmpty {
            store.mutate { file in
                for i in file.tasks.indices {
                    var t = file.tasks[i]
                    guard let workspaceId = t.workspaceId else { continue }
                    let exists = descriptorWorkspaceIds.contains(workspaceId)
                    switch (exists, t.provisionState) {
                    case (true, .pending):
                        t.provisionState = .failed(reason: "interrupted")
                        t.updatedAt = Date()
                        file.tasks[i] = t
                    case (true, .failed(let reason))
                         where reason == "worktree missing" || reason == "interrupted":
                        t.provisionState = .ready
                        t.updatedAt = Date()
                        file.tasks[i] = t
                    case (false, _) where !t.provisionState.isFailed:
                        t.provisionState = .failed(reason: "worktree missing")
                        t.updatedAt = Date()
                        file.tasks[i] = t
                    default:
                        break
                    }
                }
            }
        }

        // Build set of keys already present in tasks.
        var existingKeys: Set<Key> = []
        for task in store.fileSnapshot().tasks {
            guard let path = task.worktreePath else { continue }
            let key = Key(
                projectId: store.projectId,
                normalizedPath: TaskPathNormalization.normalize(path, relativeTo: projectRoot)
            )
            existingKeys.insert(key)
        }

        // Import any orphan workspaces.
        store.mutate { file in
            for (key, d) in descriptorByKey where !existingKeys.contains(key) {
                let title = d.branch ?? (URL(fileURLWithPath: d.worktreePath).lastPathComponent)
                let inProgressRanks = file.tasks
                    .filter { $0.columnId == .inProgress && $0.archivedAt == nil }
                    .map(\.rank)
                    .sorted()
                let rank: String = inProgressRanks.last.map(TaskRanking.after) ?? TaskRanking.initial()
                let task = TaskRecord(
                    projectId: store.projectId,
                    title: title,
                    columnId: .inProgress,
                    rank: rank,
                    workspaceId: d.workspaceId,
                    worktreePath: d.worktreePath,
                    branch: d.branch,
                    bindingGeneration: 1,
                    provisionState: .ready
                )
                file.tasks.append(task)
            }
        }
        try store.saveNow()
    }

    private struct Key: Hashable {
        let projectId: UUID
        let normalizedPath: String
    }
}
