// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation

struct WorktreeProjectionEntry: Equatable, Identifiable {
    let id: String
    let projectId: UUID
    let projectFolder: String
    let path: String
    let pathKey: String
    let branch: String?
    let isPhysical: Bool
    let isMain: Bool
    let isLocked: Bool
    let isPrunable: Bool
    let workspaceIds: [UUID]
    let taskIds: [UUID]
    let remoteWorkItemKeys: [String]

    var hasTaskBinding: Bool { !taskIds.isEmpty }
    var hasOpenWorkspace: Bool { !workspaceIds.isEmpty }
}

struct WorktreeProjectionSnapshot: Equatable {
    let projectId: UUID
    let projectFolder: String
    let entries: [WorktreeProjectionEntry]

    var taskWorktreePathKeys: Set<String> {
        Set(entries.filter(\.hasTaskBinding).map(\.pathKey))
    }

    func entry(forWorktreePath path: String?) -> WorktreeProjectionEntry? {
        guard let key = Self.pathKey(path, relativeTo: projectFolder) else { return nil }
        return entries.first { $0.pathKey == key }
    }

    func workspaceIds(forWorktreePath path: String?) -> [UUID] {
        entry(forWorktreePath: path)?.workspaceIds ?? []
    }

    static func pathKey(_ rawPath: String?, relativeTo projectFolder: String) -> String? {
        TaskPathNormalization
            .resolveDisplayAndKey(
                rawPath,
                relativeTo: URL(fileURLWithPath: projectFolder, isDirectory: true)
            )?
            .keyPath
    }
}

@MainActor
final class WorktreeProjectionStore: ObservableObject {
    static let shared = WorktreeProjectionStore()

    @Published private(set) var version: UInt64 = 0

    private var invalidationToken: GitPresentationInvalidationCenter.ObservationToken?

    private init() {
        invalidationToken = GitPresentationInvalidationCenter.observe { [weak self] event in
            DispatchQueue.main.async {
                self?.handleInvalidation(event)
            }
        }
    }

    func snapshot(
        projectId: UUID,
        workspaces: [Workspace] = [],
        maximumAge: TimeInterval? = 60
    ) -> WorktreeProjectionSnapshot? {
        guard let project = ProjectStore.shared.project(id: projectId) else { return nil }
        return snapshot(project: project, workspaces: workspaces, maximumAge: maximumAge)
    }

    func snapshot(
        project: Project,
        workspaces: [Workspace] = [],
        maximumAge: TimeInterval? = 60
    ) -> WorktreeProjectionSnapshot {
        let projectFolder = project.folderPath
        var drafts: [String: Draft] = [:]

        func upsert(path rawPath: String?, mutate: (inout Draft) -> Void) {
            guard let path = normalizedPath(rawPath),
                  let key = WorktreeProjectionSnapshot.pathKey(path, relativeTo: projectFolder) else { return }
            var draft = drafts[key] ?? Draft(
                id: "path:\(path)",
                projectId: project.id,
                projectFolder: projectFolder,
                path: path,
                pathKey: key
            )
            mutate(&draft)
            drafts[key] = draft
        }

        let registry = WorktreeRegistry.shared.cachedSnapshot(
            projectFolder: projectFolder,
            maximumAge: maximumAge
        ) ?? WorktreeRegistry.shared.lastSuccessfulSnapshot(
            projectFolder: projectFolder
        )
        if let registry {
            for entry in registry.entries {
                upsert(path: entry.path) { draft in
                    draft.path = normalizedPath(entry.path) ?? entry.path
                    draft.id = "path:\(draft.path)"
                    draft.branch = firstNonEmpty(draft.branch, entry.branch)
                    draft.isPhysical = true
                    draft.isMain = entry.isMain
                    draft.isLocked = entry.isLocked
                    draft.isPrunable = entry.isPrunable
                }
            }
        }

        let metadataStore = WorkspaceMetadataStore.shared
        let workspaceById = Dictionary(
            workspaces.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var workspaceIds = Set(metadataStore.workspaceIds(inProject: project.id))
        workspaceIds.formUnion(workspaces.compactMap { workspace in
            workspace.projectId == project.id ? workspace.id : nil
        })

        for workspaceId in workspaceIds {
            let workspace = workspaceById[workspaceId]
            let metadataPath = metadataStore.worktreePath(forWorkspaceId: workspaceId)
            let reportedPath = metadataStore.reportedStatePath(
                forWorkspaceId: workspaceId,
                fallbackPath: workspace?.termLoopPresentationCwd() ?? metadataPath
            )
            let branch = metadataStore.metadata(forWorkspaceId: workspaceId).branch
            let path = metadataPath ?? (branch == nil ? nil : reportedPath)
            upsert(path: path) { draft in
                draft.workspaceIds.insert(workspaceId)
                draft.branch = firstNonEmpty(draft.branch, branch)
            }
        }

        if let taskStore = TaskBoardStoreProvider.shared.store(for: project.id) {
            for task in taskStore.fileSnapshot().tasks where task.archivedAt == nil {
                upsert(path: task.worktreePath) { draft in
                    draft.taskIds.insert(task.id)
                    draft.branch = firstNonEmpty(draft.branch, task.branch)
                    if let key = task.remoteWorkItem?.storageKey {
                        draft.remoteWorkItemKeys.insert(key)
                    }
                }
            }
        }

        let entries = drafts.values
            .map(\.entry)
            .sorted { lhs, rhs in
                if lhs.isMain != rhs.isMain { return lhs.isMain && !rhs.isMain }
                if lhs.branch != rhs.branch {
                    return (lhs.branch ?? "").localizedStandardCompare(rhs.branch ?? "") == .orderedAscending
                }
                return lhs.path.localizedStandardCompare(rhs.path) == .orderedAscending
            }

        return WorktreeProjectionSnapshot(
            projectId: project.id,
            projectFolder: projectFolder,
            entries: entries
        )
    }

    func refresh(projectId: UUID, reason: String) {
        guard let project = ProjectStore.shared.project(id: projectId) else { return }
        refresh(projectFolder: project.folderPath, reason: reason)
    }

    func refresh(projectFolder: String, reason: String) {
        WorktreeRegistry.shared.refresh(projectFolder: projectFolder, reason: "projection.\(reason)") { [weak self] _ in
            self?.markChanged(reason: reason)
        }
    }

    func markChanged(reason: String) {
        version &+= 1
        #if DEBUG
        dlog("worktree.projection.changed version=\(version) reason=\(reason)")
        #endif
    }

    private func handleInvalidation(_ event: GitInvalidationEvent) {
        guard event.targets.contains(where: {
            switch $0.normalized {
            case .project, .worktree, .directory, .all:
                return true
            }
        }) else { return }
        markChanged(reason: event.reason)
    }

    private func normalizedPath(_ path: String?) -> String? {
        let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return WorktreeResolver.normalizePath(trimmed) ?? trimmed
    }

    private func firstNonEmpty(_ first: String?, _ second: String?) -> String? {
        if let value = first?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
            return value
        }
        if let value = second?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
            return value
        }
        return nil
    }

    private struct Draft {
        var id: String
        let projectId: UUID
        let projectFolder: String
        var path: String
        let pathKey: String
        var branch: String?
        var isPhysical = false
        var isMain = false
        var isLocked = false
        var isPrunable = false
        var workspaceIds = Set<UUID>()
        var taskIds = Set<UUID>()
        var remoteWorkItemKeys = Set<String>()

        var entry: WorktreeProjectionEntry {
            WorktreeProjectionEntry(
                id: id,
                projectId: projectId,
                projectFolder: projectFolder,
                path: path,
                pathKey: pathKey,
                branch: branch,
                isPhysical: isPhysical,
                isMain: isMain,
                isLocked: isLocked,
                isPrunable: isPrunable,
                workspaceIds: workspaceIds.sorted { $0.uuidString < $1.uuidString },
                taskIds: taskIds.sorted { $0.uuidString < $1.uuidString },
                remoteWorkItemKeys: remoteWorkItemKeys.sorted()
            )
        }
    }
}
