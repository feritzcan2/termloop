// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public struct TaskWorkspaceDescriptor: Equatable, Sendable {
    public let workspaceId: UUID?
    public let projectId: UUID
    public let branch: String?
    public let worktreePath: String

    public init(workspaceId: UUID?, projectId: UUID, branch: String?, worktreePath: String) {
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.branch = branch
        self.worktreePath = worktreePath
    }
}

@MainActor
public protocol TaskBoardWorkspaceListing: AnyObject {
    func workspaces(in projectId: UUID) async -> [TaskWorkspaceDescriptor]
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

    public func run() async throws {
        let projectRoot = workspaces.projectRoot(for: store.projectId)
        let descriptors = await workspaces.workspaces(in: store.projectId)
        // Use bucketed dictionary, NOT `Dictionary(uniqueKeysWithValues:)` — duplicates would crash.
        // Two metadata records pointing at the same normalized path is corruption; keep first, surface repair banner via reconcile.
        var descriptorByKey: [Key: TaskWorkspaceDescriptor] = [:]
        var descriptorByWorkspaceId: [UUID: TaskWorkspaceDescriptor] = [:]
        for d in descriptors {
            guard let resolved = TaskPathNormalization.resolveDisplayAndKey(d.worktreePath, relativeTo: projectRoot) else {
                continue
            }
            let key = Key(projectId: store.projectId, normalizedPath: resolved.keyPath)
            if descriptorByKey[key] == nil {
                descriptorByKey[key] = d
            }
            if let workspaceId = d.workspaceId, descriptorByWorkspaceId[workspaceId] == nil {
                descriptorByWorkspaceId[workspaceId] = d
            }
            // Else: duplicate path — first wins; reconcile pass on existing tasks will flag mismatched workspaceIds via repair banner.
        }

        // Drop path-only Tasks that were auto-imported from external git
        // worktrees before Tasks learned to restrict discovery to
        // <project>/.termloop-worktrees/. Live metadata-backed worktrees are
        // never removed here; user-renamed tasks are left for repair.
        var changed = store.mutate { file in
            let before = file.tasks.count
            file.tasks.removeAll { task in
                isExternalPathOnlyAutoImport(
                    task,
                    projectRoot: projectRoot,
                    descriptorByKey: descriptorByKey
                )
            }
            return file.tasks.count != before
        }

        // Validate existing tasks.
        // Prefer workspace-id matches when available, but also recover by
        // normalized worktree path. Metadata rows can be absent while the
        // physical git worktree is still present (for example after restore or
        // a metadata reset); in that case the task is still bound to an on-disk
        // worktree and must not stay red as "missing".
        //
        // If descriptors are empty, only workspace-less pending tasks are
        // marked interrupted. Bound task validation is skipped because we
        // cannot trust the listing yet.
        // Self-recovering: a task previously stuck on .failed("worktree
        // missing"/"interrupted") that now resolves cleanly is reset to .ready.
        let validated = store.mutate { file in
            var changed = false
            for i in file.tasks.indices {
                var t = file.tasks[i]

                let pathKey: Key? = t.worktreePath.map {
                    TaskPathNormalization.resolveDisplayAndKey($0, relativeTo: projectRoot).map {
                        Key(projectId: store.projectId, normalizedPath: $0.keyPath)
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
                    if t.provisionState != .ready {
                        t.provisionState = .ready
                    }
                    if t != original {
                        t.updatedAt = Date()
                        file.tasks[i] = t
                        changed = true
                    }
                    continue
                }

                guard t.workspaceId != nil || t.worktreePath != nil else {
                    if case .pending = t.provisionState {
                        t.provisionState = .failed(reason: TaskProvisionFailureReason.interrupted)
                        t.updatedAt = Date()
                        file.tasks[i] = t
                        changed = true
                    }
                    continue
                }

                guard !descriptors.isEmpty else { continue }

                if !t.provisionState.isFailed {
                    t.provisionState = .failed(reason: TaskProvisionFailureReason.worktreeMissing)
                    t.updatedAt = Date()
                    file.tasks[i] = t
                    changed = true
                }
            }
            return changed
        }
        changed = changed || validated

        // Build set of keys already present in tasks.
        var existingKeys: Set<Key> = []
        for task in store.fileSnapshot().tasks {
            guard let path = task.worktreePath else { continue }
            guard let resolved = TaskPathNormalization.resolveDisplayAndKey(path, relativeTo: projectRoot) else { continue }
            let key = Key(projectId: store.projectId, normalizedPath: resolved.keyPath)
            existingKeys.insert(key)
        }

        // Import any orphan workspaces.
        let imported = store.mutate { file in
            var changed = false
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
                changed = true
            }
            if changed {
                _ = TaskBoardStore.rebalanceColumnIfNeeded(.inProgress, in: &file)
            }
            return changed
        }
        changed = changed || imported
        if changed {
            try store.saveNow()
        }
    }

    private struct Key: Hashable {
        let projectId: UUID
        let normalizedPath: String
    }

    private func isExternalPathOnlyAutoImport(
        _ task: TaskRecord,
        projectRoot: URL,
        descriptorByKey: [Key: TaskWorkspaceDescriptor]
    ) -> Bool {
        guard task.archivedAt == nil,
              task.workspaceId == nil,
              task.bindingGeneration == 1,
              case .ready = task.provisionState,
              let worktreePath = task.worktreePath,
              WorktreeResolver.worktreeRoot(
                  containing: worktreePath,
                  projectFolder: projectRoot.path
              ) == nil else {
            return false
        }
        guard let resolved = TaskPathNormalization.resolveDisplayAndKey(worktreePath, relativeTo: projectRoot) else {
            return false
        }
        let key = Key(projectId: store.projectId, normalizedPath: resolved.keyPath)
        guard descriptorByKey[key] == nil else { return false }
        let importedTitle = task.branch ?? URL(fileURLWithPath: worktreePath).lastPathComponent
        return task.title == importedTitle
    }
}
