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
    static func snapshots(for tasks: [TaskRecord]) -> [UUID: TaskWorkItemSnapshot] {
        Dictionary(uniqueKeysWithValues: tasks.compactMap { task in
            guard task.archivedAt == nil,
                  let snapshot = snapshot(for: task) else {
                return nil
            }
            return (task.id, snapshot)
        })
    }

    static func snapshot(for task: TaskRecord) -> TaskWorkItemSnapshot? {
        if let reference = task.remoteWorkItem {
            let cached = RemoteWorkItemSnapshotStore.shared.snapshot(for: reference)
            return remoteSnapshot(
                reference: reference,
                title: cached?.title ?? task.title,
                statusLabel: cached?.statusLabel ?? task.remoteStatusLabel,
                urlString: cached?.reference.url ?? reference.url,
                taskFilePath: task.taskFilePath,
                workspaceId: task.workspaceId,
                worktreePath: task.worktreePath
            )
        }
        return snapshot(workspaceId: task.workspaceId, worktreePath: task.worktreePath)
    }

    static func remoteSnapshot(
        reference: RemoteWorkItemReference,
        title: String?,
        statusLabel: String?,
        urlString: String?,
        taskFilePath: String?,
        workspaceId: UUID?,
        worktreePath: String?
    ) -> TaskWorkItemSnapshot {
        TaskWorkItemSnapshot(
            reference: reference,
            title: title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            statusLabel: statusLabel?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            urlString: urlString?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            taskFilePath: taskFilePath?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            worktreePath: worktreePath,
            workspaceId: workspaceId ?? preferredWorkspaceId(
                workspaceId: workspaceId,
                worktreePath: worktreePath
            )
        )
    }

    static func snapshot(
        workspaceId: UUID?,
        worktreePath: String?
    ) -> TaskWorkItemSnapshot? {
        let paths = worktreePaths(workspaceId: workspaceId, worktreePath: worktreePath)
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
                    worktreePath: worktreePath
                )
            )
        }
        return nil
    }

    static func preferredWorkspaceId(workspaceId: UUID?, worktreePath: String?) -> UUID? {
        if let workspaceId { return workspaceId }
        guard let path = TaskPathNormalization.resolveDisplayAndKey(worktreePath)?.displayPath else {
            return nil
        }
        return WorkspaceMetadataStore.shared.workspaceIds(withWorktreePath: path).first
    }

    private static func worktreePaths(
        workspaceId: UUID?,
        worktreePath: String?
    ) -> [(path: String, workspaceId: UUID?)] {
        let metadata = WorkspaceMetadataStore.shared
        let normalizedPath = TaskPathNormalization.resolveDisplayAndKey(worktreePath)?.displayPath
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
            for id in metadata.workspaceIds(withWorktreePath: normalizedPath) {
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

}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
