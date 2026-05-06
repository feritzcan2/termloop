// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Read-only Tasks projection over the existing worktree-scoped work item
/// binding. Tasks do not own remote issue state; they render whatever is
/// attached to the task's worktree through `AgentReportedStateStore`.
struct TaskWorkItemSnapshot: Equatable, Identifiable {
    let reference: RemoteWorkItemReference
    let binding: AgentReportedStateStore.AgentReportedBinding
    let reportedStatePath: String
    let workspaceId: UUID?

    var id: String { reference.storageKey }

    var key: String { reference.key }

    var statusLabel: String? {
        binding.status?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    var url: URL? {
        reference.url.flatMap(URL.init(string:)) ?? binding.destinationURL
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
                  let snapshot = snapshot(
                    workspaceId: task.workspaceId,
                    worktreePath: task.worktreePath
                  ) else {
                return nil
            }
            return (task.id, snapshot)
        })
    }

    static func snapshot(
        workspaceId: UUID?,
        worktreePath: String?
    ) -> TaskWorkItemSnapshot? {
        let paths = reportedStatePaths(workspaceId: workspaceId, worktreePath: worktreePath)
        for candidate in paths {
            guard let binding = AgentReportedStateStore.shared.binding(
                abilityId: TermLoopBuiltInMCP.jiraAbilityId,
                bindingId: JiraTicketBindingPrompt.bindingId,
                forPath: candidate.path
            ),
                  var reference = reference(from: binding) else {
                continue
            }
            if reference.url == nil {
                reference.url = binding.url?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            }
            return TaskWorkItemSnapshot(
                reference: reference,
                binding: binding,
                reportedStatePath: candidate.path,
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

    private static func reportedStatePaths(
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

    private static func reference(
        from binding: AgentReportedStateStore.AgentReportedBinding
    ) -> RemoteWorkItemReference? {
        [
            binding.url?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            binding.label.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        ]
        .compactMap { $0 }
        .lazy
        .compactMap(RemoteWorkItemParser.parse)
        .first
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
