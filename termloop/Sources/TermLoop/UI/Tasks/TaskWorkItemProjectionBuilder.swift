// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Read-only Tasks projection over user/app-owned remote item bindings.
struct TaskWorkItemSnapshot: Equatable, Identifiable {
    let reference: RemoteWorkItemReference
    let title: String?
    let statusLabel: String?
    let urlString: String?
    let taskFilePath: String?
    let worktreePath: String?
    let workspaceId: UUID?

    var id: String { reference.storageKey }

    var key: String { reference.key }

    var url: URL? {
        urlString.flatMap(URL.init(string:))
    }

    var compactLabel: String {
        guard let statusLabel else { return key }
        return "\(key) · \(statusLabel)"
    }
}

@MainActor
enum TaskWorkItemProjectionBuilder {
    static func snapshots(for tasks: [TaskRecord], projectId: UUID? = nil) -> [UUID: TaskWorkItemSnapshot] {
        let resolvedProjection = worktreeProjection(projectId: projectId, existing: nil)
        return Dictionary(uniqueKeysWithValues: tasks.compactMap { task in
            guard task.archivedAt == nil,
                  let snapshot = snapshot(for: task, projectId: projectId, projection: resolvedProjection) else {
                return nil
            }
            return (task.id, snapshot)
        })
    }

    static func snapshot(
        for task: TaskRecord,
        projectId: UUID? = nil,
        projection: WorktreeProjectionSnapshot? = nil
    ) -> TaskWorkItemSnapshot? {
        let resolvedProjection = worktreeProjection(projectId: projectId, existing: projection)
        if let reference = task.remoteWorkItem {
            let cached = RemoteWorkItemSnapshotStore.shared.snapshot(for: reference)
            return remoteSnapshot(
                reference: reference,
                title: cached?.title ?? task.title,
                statusLabel: cached?.statusLabel ?? task.remoteStatusLabel,
                urlString: cached?.reference.url ?? reference.url,
                taskFilePath: task.taskFilePath,
                workspaceId: task.workspaceId,
                worktreePath: task.worktreePath,
                projectId: projectId,
                projection: resolvedProjection
            )
        }
        return snapshot(
            workspaceId: task.workspaceId,
            worktreePath: task.worktreePath,
            projectId: projectId,
            projection: resolvedProjection
        )
    }

    static func remoteSnapshot(
        reference: RemoteWorkItemReference,
        title: String?,
        statusLabel: String?,
        urlString: String?,
        taskFilePath: String?,
        workspaceId: UUID?,
        worktreePath: String?,
        projectId: UUID? = nil,
        projection: WorktreeProjectionSnapshot? = nil
    ) -> TaskWorkItemSnapshot {
        let resolvedProjection = worktreeProjection(projectId: projectId, existing: projection)
        return TaskWorkItemSnapshot(
            reference: reference,
            title: title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            statusLabel: statusLabel?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            urlString: urlString?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            taskFilePath: taskFilePath?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            worktreePath: worktreePath,
            workspaceId: workspaceId ?? preferredWorkspaceId(
                workspaceId: workspaceId,
                worktreePath: worktreePath,
                projectId: projectId,
                projection: resolvedProjection
            )
        )
    }

    static func snapshot(
        workspaceId: UUID?,
        worktreePath: String?,
        projectId: UUID? = nil,
        projection: WorktreeProjectionSnapshot? = nil
    ) -> TaskWorkItemSnapshot? {
        let resolvedProjection = worktreeProjection(projectId: projectId, existing: projection)
        let paths = worktreePaths(
            workspaceId: workspaceId,
            worktreePath: worktreePath,
            projectId: projectId,
            projection: resolvedProjection
        )
        for candidate in paths {
            guard let binding = WorktreeRemoteItemBindingStore.shared.binding(forPath: candidate.path) else {
                continue
            }
            let cached = RemoteWorkItemSnapshotStore.shared.snapshot(for: binding.reference)
            return TaskWorkItemSnapshot(
                reference: cached?.reference ?? binding.reference,
                title: cached?.title.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                statusLabel: cached?.statusLabel?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                urlString: (cached?.reference.url ?? binding.reference.url)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty,
                taskFilePath: nil,
                worktreePath: candidate.path,
                workspaceId: candidate.workspaceId ?? preferredWorkspaceId(
                    workspaceId: workspaceId,
                    worktreePath: worktreePath,
                    projectId: projectId,
                    projection: resolvedProjection
                )
            )
        }
        return nil
    }

    static func preferredWorkspaceId(
        workspaceId: UUID?,
        worktreePath: String?,
        projectId: UUID? = nil,
        projection: WorktreeProjectionSnapshot? = nil
    ) -> UUID? {
        if let workspaceId { return workspaceId }
        guard let path = TaskPathNormalization.resolveDisplayAndKey(worktreePath)?.displayPath else {
            return nil
        }
        let resolvedProjection = worktreeProjection(projectId: projectId, existing: projection)
        if let id = resolvedProjection?.workspaceIds(forWorktreePath: path).first {
            return id
        }
        return WorkspaceMetadataStore.shared.workspaceIds(withWorktreePath: path).first
    }

    private static func worktreePaths(
        workspaceId: UUID?,
        worktreePath: String?,
        projectId: UUID? = nil,
        projection: WorktreeProjectionSnapshot? = nil
    ) -> [(path: String, workspaceId: UUID?)] {
        let metadata = WorkspaceMetadataStore.shared
        let normalizedPath = TaskPathNormalization.resolveDisplayAndKey(worktreePath)?.displayPath
        let resolvedProjection = worktreeProjection(projectId: projectId, existing: projection)
        var result: [(String, UUID?)] = []
        var seen = Set<String>()

        func append(_ path: String?, workspaceId: UUID?) {
            let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !trimmed.isEmpty, !seen.contains(trimmed) else { return }
            seen.insert(trimmed)
            result.append((trimmed, workspaceId))
        }

        if let workspaceId {
            append(
                metadata.reportedStatePath(
                    forWorkspaceId: workspaceId,
                    fallbackPath: normalizedPath
                ),
                workspaceId: workspaceId
            )
        }

        if let normalizedPath {
            let workspaceIds: [UUID]
            if let resolvedProjection {
                workspaceIds = resolvedProjection.workspaceIds(forWorktreePath: normalizedPath)
            } else {
                workspaceIds = metadata.workspaceIds(withWorktreePath: normalizedPath)
            }
            for id in workspaceIds {
                append(
                    metadata.reportedStatePath(forWorkspaceId: id, fallbackPath: normalizedPath),
                    workspaceId: id
                )
            }
            append(TaskPathNormalization.normalize(normalizedPath), workspaceId: nil)
            append(normalizedPath, workspaceId: nil)
        }

        return result
    }

    private static func worktreeProjection(
        projectId: UUID?,
        existing: WorktreeProjectionSnapshot?
    ) -> WorktreeProjectionSnapshot? {
        if let existing { return existing }
        guard let projectId else { return nil }
        return WorktreeProjectionStore.shared.snapshot(projectId: projectId)
    }

}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
